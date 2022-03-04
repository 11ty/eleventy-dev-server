function getContentType(headers) {
  if(!headers) {
    return;
  }

  for(let key in headers) {
    if(key.toLowerCase() === "content-type") {
      return headers[key];
    }
  }
}

// Inspired by `resp-modifier` https://github.com/shakyShane/resp-modifier/blob/4a000203c9db630bcfc3b6bb8ea2abc090ae0139/index.js
function wrapResponse(resp, transformHtml) {
  resp._wrappedHeaders = [];
  resp._wrappedTransformHtml = transformHtml;
  resp._wrappedOriginalWrite = resp.write;
  resp._wrappedOriginalWriteHead = resp.writeHead;
  resp._wrappedOriginalEnd = resp.end;

  // Original signature writeHead(statusCode[, statusMessage][, headers])
  resp.writeHead = function(statusCode, ...args) {
    let headers = args[args.length - 1];
    // statusMessage is a string
    if(typeof headers !== "string") {
      this._contentType = getContentType(headers);
    }

    resp._wrappedOriginalWriteHead(statusCode, ...args);
  }

  // data can be a String or Buffer
  resp.write = function(data, ...args) {
    if(typeof data === "string") {
      if(!resp._writeCache) {
        resp._writeCache = "";
      }

      // TODO encoding and callback args
      resp._writeCache += data;
    } else {
      // Buffers
      resp._wrappedOriginalWrite(data, ...args);
    }
  }

  // data can be a String or Buffer
  resp.end = function(data, ...args) {
    if(typeof resp._writeCache === "string" || typeof data === "string") {
      if(!resp._writeCache) {
        resp._writeCache = "";
      }

      if(typeof data === "string") {
        resp._writeCache += data;
      }

      // Strings
      let result = this._writeCache;

      // we can’t inject snippet if headers have already been sent
      // because we need to change the content-length header
      if(!resp.headersSent) {
        // Only transform HTML
        // Note the “setHeader versus writeHead” note on https://nodejs.org/api/http.html#responsewriteheadstatuscode-statusmessage-headers
        let contentType = resp._contentType || getContentType(resp.getHeaders());
        if(contentType.startsWith("text/html")) {
          if(this._wrappedTransformHtml && typeof this._wrappedTransformHtml === "function") {
            result = this._wrappedTransformHtml(result);
            resp.setHeader("Content-Length", Buffer.byteLength(result));
          }
        }
      }

      resp._wrappedOriginalEnd(result, ...args);
    } else {
      // Buffers
      resp._wrappedOriginalEnd(data, ...args);
    }


    resp._writeCache = [];
    resp.write = resp._wrappedOriginalWrite;
    resp.writeHead = resp._wrappedOriginalWriteHead;
    resp.end = resp._wrappedOriginalEnd;
  }

  return resp;
}

module.exports = wrapResponse;