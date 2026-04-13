# zest3

Serves documents from MongoDB by URI path. Only dependency is the `mongodb` driver.

All paths received by this app are absolute.  The following are each distinct:

- /foo/bar
- /foo/bar/
- /foo/bar/index.html

Request paths are URL-decoded before lookup. For example, `/foo%20bar` resolves the same document as `/foo bar`.

Any requests that have query parameters attached will receive a `403 Forbidden` response.

This application is read-only and does not modify data in MongoDB. Handle document CRUD operations outside this app. The one exception is `CREATE_INDEX=true`, which causes the app to create a unique index on the `path` field at startup if one does not already exist.

## Endpoints

- `GET /health` — health check
- `GET /<path>` — serve document
- `HEAD /<path>` — headers only

## Document fields

| Field | Required | Description |
|---|---|---|
| `path` | yes | URI path key, unique |
| `content` | yes | Response body |
| `lastModified` | yes | Source timestamp for the `Last-Modified` header |
| `mimetype` | no | Sent as `Content-Type` (defaults to "application/octet-stream") |
| `maxage` | no | Adds `Cache-Control: public, max-age=<maxage>` (can be combined with s-maxage) |
| `smaxage` | no | Adds `Cache-Control: public, s-maxage=<smaxage>` (can be combined with max-age) |
| `headers` | no | Add custom headers to the response (array) |

If neither `maxage` nor `smaxage` is specified, responses default to `Cache-Control: public, max-age=0`.

Missing documents return `404 Not Found` with `Cache-Control: no-cache` so clients revalidate instead of caching the miss. Error responses such as `403`, `405`, `500`, `503`, and `504` are sent with `Cache-Control: no-store`.

Responses include `Last-Modified` from the document and an `ETag` in the form `<lastModifiedUnixTime>-<sha256(content).slice(0,16)>`. Clients that send a matching `If-None-Match` receive `304 Not Modified`; otherwise, `If-Modified-Since` is used as a fallback validator.

### Custom Headers

The `headers` field allows you to add or override any HTTP response headers. This is by design that you can override any header zest3 would normally send, including `Content-Type`, `ETag`, `Last-Modified`, and `Content-Length`. Use this power carefully; incorrect headers can break client behavior. However, this flexibility enables advanced use cases where you need full control over the response.

```javascript
db.documents.insertOne({
	path: "/api/data",
	content: '[]',
	mimetype: 'text/json',
	lastModified: new Date(),
	headers: {
		"X-Custom-Header": "value",
		"Content-Type": "text/custom"  // Override the expected type, even if already defined as mimetype
	}
});
```

## CORS

CORS headers are automatically included in all responses with the following defaults:

| Header | Default Value |
|---|---|
| `Access-Control-Allow-Origin` | `*` |
| `Access-Control-Allow-Methods` | `GET, HEAD, OPTIONS` |
| `Access-Control-Allow-Headers` | `*` |

You can override CORS headers using the `headers` field (see [Custom Headers](#custom-headers) section above).

## Setup

```bash
cp .env.example .env
# edit .env — all values are required except CREATE_INDEX
npm install
npm start
```

## Config (`.env`) or environment variables

All variables are required. The app will exit with an error if any are missing.

When values are quoted in `.env`, zest3 also supports the escape sequences `\n`, `\r`, `\t`, `\\`, and `\"`.

```
PORT=3000
MONGODB_URI=mongodb://localhost:27017
DB_NAME=zest3
COLLECTION_NAME=documents
```

```
CREATE_INDEX=false
```

`CREATE_INDEX` is optional. Set it to `true` to auto-create the required unique index on `path` at startup when missing.

## mongosh Insert Example

```javascript
use("zest3");

db.documents.insertOne({
	path: "/",
	content: "<h1>Hello World!</h1><p> - from zest3</p>",
	mimetype: "text/html; charset=utf-8",
	lastModified: new Date(),
	maxage: 3600
});
```

## Docker

```bash
docker build -t zest3 .
```

`PORT` defaults to `3000` in the image. You can set a different build-time default (used by `EXPOSE`) by setting it in .env, your environment, or with `--build-arg PORT=<port>`.

The image does not bake application environment variables, e.g. NODE_ENV. Pass them via .env, your environment, or at runtime with `--env-file` or `-e`.

This image does not run MongoDB. It always connects to an external MongoDB instance.

For Linux hosts where MongoDB runs directly on the host, use host networking:

Include or omit `--env-file .env` according to your setup.

```bash
# foreground w/ .env
docker run --rm --network host --env-file .env zest3

# foreground w/o .env
docker run --rm --network host \
  -e PORT \
  -e MONGODB_URI \
  -e DB_NAME \
  -e COLLECTION_NAME \
  zest3

# background with restarts unless stopped (including reboots)
docker run -d  --restart=unless-stopped --name zest3 --network host --env-file .env zest3

# or
docker run -d  --restart=unless-stopped --name zest3 --network \
  -e PORT \
  -e MONGODB_URI \
  -e DB_NAME \
  -e COLLECTION_NAME \
  zest3
```