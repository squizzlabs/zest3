const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

if (!process.env.PORT || !process.env.MONGODB_URI || !process.env.DB_NAME || !process.env.COLLECTION_NAME) {
	// Load .env without any external dependency
	const dotEnvPath = path.join(__dirname, ".env");

	if (fs.existsSync(dotEnvPath)) {
		const lines = fs.readFileSync(dotEnvPath, "utf8").split(/\r?\n/);
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq === -1) continue;

			const key = trimmed.slice(0, eq).trim();
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

			let value = trimmed.slice(eq + 1).trim();
			if (
				(value.startsWith('"') && value.endsWith('"'))
				|| (value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}

			if (process.env[key] == null) process.env[key] = value;
		}
	} else {
		console.warn(".env file not found, skipping environment variable loading from file.");
	}
}

const PORT_RAW = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME;
const COLLECTION_NAME = process.env.COLLECTION_NAME;
const CREATE_INDEX_RAW = process.env.CREATE_INDEX;

function parseBooleanEnv(value, defaultValue = false) {
	if (value == null) return defaultValue;
	const normalized = String(value).trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return defaultValue;
}

const CREATE_INDEX = parseBooleanEnv(CREATE_INDEX_RAW, false);

const missingRequiredEnv = [];
if (!MONGODB_URI) missingRequiredEnv.push("MONGODB_URI");
if (!DB_NAME) missingRequiredEnv.push("DB_NAME");
if (!COLLECTION_NAME) missingRequiredEnv.push("COLLECTION_NAME");

if (missingRequiredEnv.length > 0) {
	console.error(`Missing required environment variables: ${missingRequiredEnv.join(", ")}`);
	process.exit(1);
}

const PORT = Number(PORT_RAW);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
	console.error("Invalid PORT. Expected an integer between 1 and 65535.");
	process.exit(1);
}
const RESPONSE_TIMEOUT_MS = 10000;
const MAX_TTL_SECONDS = 31536000;

let collection;

function sendJson(res, status, data, extraHeaders = {}) {
	const body = JSON.stringify(data);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		...extraHeaders
	});
	res.end(body);
}

function sanitizeHeaderValue(value) {
	if (value == null) return null;
	const text = String(value).trim();
	if (!text) return null;
	if (/[\r\n\0]/.test(text)) return null;
	return text;
}

function sanitizeMimeType(value) {
	const text = sanitizeHeaderValue(value);
	if (!text) return "application/octet-stream";
	return text;
}

function sanitizeTtl(value) {
	if (value == null) return null;
	const ttl = Number(value);
	if (!Number.isFinite(ttl)) return null;
	const ttlInt = Math.floor(ttl);
	if (ttlInt < 0) return null;
	return Math.min(ttlInt, MAX_TTL_SECONDS);
}

function sanitizeCacheTags(value) {
	if (value == null) return null;
	const tags = [].concat(value)
		.map(sanitizeHeaderValue)
		.filter(Boolean);
	if (tags.length === 0) return null;
	return tags.join(",");
}

function toLastModifiedDate(value) {
	if (value == null) return null;

	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return null;

	date.setMilliseconds(0);
	return date;
}

function parseIfModifiedSince(headerValue) {
	const text = sanitizeHeaderValue(headerValue);
	if (!text) return null;

	const date = new Date(text);
	if (Number.isNaN(date.getTime())) return null;

	date.setMilliseconds(0);
	return date;
}

function createEtag(lastModified, body) {
	const unixTime = Math.floor(lastModified.getTime() / 1000);
	const md5 = crypto.createHash("md5").update(body).digest("hex");
	return `"${unixTime}-${md5}"`;
}

function parseIfNoneMatch(headerValue) {
	const text = sanitizeHeaderValue(headerValue);
	if (!text) return null;

	if (text === "*") return ["*"];

	return text
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

function stripWeakPrefix(tag) {
	if (typeof tag !== "string") return null;
	return tag.startsWith("W/") ? tag.slice(2) : tag;
}

function etagMatches(ifNoneMatchHeader, etag) {
	const candidates = parseIfNoneMatch(ifNoneMatchHeader);
	if (!candidates || candidates.length === 0) return false;
	if (candidates.includes("*")) return true;

	const normalizedEtag = stripWeakPrefix(etag);
	return candidates.some((candidate) => stripWeakPrefix(candidate) === normalizedEtag);
}

async function handleGetDoc(req, res, pathname, headOnly = false) {
	const requestPath = pathname || "/";
	const doc = await collection.findOne(
		{ path: requestPath },
		{ projection: { _id: 0 } }
	);

	if (res.writableEnded) return;

	if (!doc) {
		sendJson(res, 404, { error: "Not found" }, { "Cache-Control": "public, max-age=300" });
		return;
	}

	const lastModified = toLastModifiedDate(doc.lastModified);
	if (!lastModified) {
		sendJson(res, 404, { error: "Not found" }, { "Cache-Control": "public, max-age=300" });
		return;
	}

	const body = Buffer.from(doc.content ?? "", "utf8");
	const mimetype = sanitizeMimeType(doc.mimetype);
	const etag = createEtag(lastModified, body);
	const headers = {
		"Content-Type": mimetype,
		ETag: etag,
		"Last-Modified": lastModified.toUTCString(),
		"Content-Length": body.length
	};
	const ttl = sanitizeTtl(doc.ttl);
	if (ttl != null) headers["Cache-Control"] = `public, max-age=${ttl}`;
	const cacheTags = sanitizeCacheTags(doc.cacheTags);
	if (cacheTags) headers["Cache-Tag"] = cacheTags;
	
	// Allow for any custom headers from the document
	if (doc.headers && typeof doc.headers === "object") {
		for (const [key, value] of Object.entries(doc.headers)) {
			const sanitizedValue = sanitizeHeaderValue(value);
			if (sanitizedValue) {
				headers[key] = sanitizedValue;
			}
		}
	}

	const hasIfNoneMatch = sanitizeHeaderValue(req.headers["if-none-match"]) != null;
	if (hasIfNoneMatch && etagMatches(req.headers["if-none-match"], etag)) {
		delete headers["Content-Length"];
		if (res.writableEnded) return;
		res.writeHead(304, headers);
		res.end();
		return;
	}

	const ifModifiedSince = parseIfModifiedSince(req.headers["if-modified-since"]);
	if (!hasIfNoneMatch && ifModifiedSince && lastModified.getTime() <= ifModifiedSince.getTime()) {
		delete headers["Content-Length"];
		if (res.writableEnded) return;
		res.writeHead(304, headers);
		res.end();
		return;
	}

	if (res.writableEnded) return;
	res.writeHead(200, headers);
	res.end(headOnly ? undefined : body);
}

async function handleHealth(res) {
	if (!collection) {
		sendJson(res, 503, { ok: false, error: "Database unavailable" });
		return;
	}

	try {
		const hello = await collection.db.admin().command({ hello: 1 });
		if (res.writableEnded) return;

		sendJson(res, 200, {
			ok: hello && hello.ok === 1
		});
	} catch (error) {
		console.error("Health check failed", error);
		if (res.writableEnded) return;
		sendJson(res, 503, { ok: false, error: "Database unavailable" });
	}
}

function routeFromRequest(pathname) {
	const pathOnly = pathname || "/";

	if (pathOnly === "/health") {
		return { type: "health" };
	}

	return { type: "doc", path: pathOnly };
}

function requestHandler(req, res) {
	const timeoutHandle = setTimeout(() => {
		if (res.writableEnded) return;
		sendJson(res, 504, { error: "Request timeout" });
		clearTimeout(timeoutHandle);
	}, RESPONSE_TIMEOUT_MS);
	try {
		if ((req.url || "").includes("?")) {
			sendJson(res, 403, { error: "Forbidden" });
			clearTimeout(timeoutHandle);
			return;
		}

		const route = routeFromRequest(req.url || "/");

		if (route.type === "health") {
			handleHealth(res)
				.finally(() => {
					clearTimeout(timeoutHandle);
				});
			return;
		}

		if (req.method === "GET" || req.method === "HEAD") {
			handleGetDoc(req, res, route.path, req.method === "HEAD")
				.then(() => {
					clearTimeout(timeoutHandle);
				})
				.catch((error) => {
					console.error(error);
					if (!res.writableEnded) sendJson(res, 500, { error: "Internal server error" });
					clearTimeout(timeoutHandle);
				});
			return;
		}

		sendJson(res, 405, { error: "Not Allowed" });
		clearTimeout(timeoutHandle);
	} catch (error) {
		console.error("Error in requestHandler:", error);
		if (!res.writableEnded) sendJson(res, 500, { error: "Internal server error" });
		clearTimeout(timeoutHandle);
	}
}

async function shutdown(signal) {
	console.log(` ... shutting down`);
	process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
	process.on(signal, () => shutdown(signal));
}

async function start() {
	const client = new MongoClient(MONGODB_URI);
	await client.connect();

	const db = client.db(DB_NAME);
	const collectionInfo = await db.listCollections(
		{ name: COLLECTION_NAME },
		{ nameOnly: true }
	).next();
	if (!collectionInfo) {
		console.error(`Error: Collection ${COLLECTION_NAME} not found in database ${DB_NAME}`);
		process.exit(2);
	}
	collection = db.collection(COLLECTION_NAME);

	console.log(`Connected to MongoDB! Database: ${DB_NAME}, Collection: ${COLLECTION_NAME}`);

	const indexes = await collection.listIndexes().toArray();
	const hasPathIndex = indexes.some(
		(idx) => idx.key && idx.key.path !== undefined && idx.unique === true
	);
	if (!hasPathIndex) {
		if (CREATE_INDEX) {
			console.log("Required unique index on 'path' is missing. Creating it because CREATE_INDEX is enabled.");
			try {
				await collection.createIndex({ path: 1 }, { unique: true });
				console.log("Created unique index on 'path'.");
			} catch (error) {
				console.error("Failed to create required unique index on 'path'", error);
				process.exit(2);
			}
		} else {
			console.error("Required unique index on 'path' does not exist. Set CREATE_INDEX=true to create it automatically.");
			process.exit(2);
		}
	}

	const server = http.createServer(requestHandler);
	server.requestTimeout = RESPONSE_TIMEOUT_MS;
	server.headersTimeout = RESPONSE_TIMEOUT_MS;
	server.timeout = RESPONSE_TIMEOUT_MS;
	server.listen(PORT, () => {
		console.log(`Listening on http://localhost:${PORT}`);
	});
}

start().catch((error) => {
	console.error("Failed to start server", error);
	process.exit(1);
});
