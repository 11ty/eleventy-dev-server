const test = require("ava");
const path = require("path");
const http = require("http");
const EleventyDevServer = require("../");

function testNormalizeFilePath(filepath) {
  return filepath.split("/").join(path.sep);
}

function getOptions(options = {}) {
  options.logger = {
    info: function() {},
    error: function() {},
  };
  return options;
}

async function makeRequestTo(t, server, path) {
  let port = await server.getPort();

  return new Promise(resolve => {
    const options = {
      hostname: 'localhost',
      port,
      path,
      method: 'GET',
    };

    http.get(options, (res) => {
      const { statusCode } = res;
      if(statusCode !== 200) {
        throw new Error("Invalid status code" + statusCode);
      }

      res.setEncoding('utf8');

      let rawData = '';
      res.on('data', (chunk) => { rawData += chunk; });
      res.on('end', () => {
        t.true( true );
        resolve(rawData);
      });
    }).on('error', (e) => {
      console.error(`Got error: ${e.message}`);
    });
  })
}

test("Url mappings for resource/index.html", t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/");

  t.deepEqual(server.mapUrlToFilePath("/route1/"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route1/index.html")
  });

  t.deepEqual(server.mapUrlToFilePath("/route1"), {
    statusCode: 301,
    url: "/route1/"
  });

  t.deepEqual(server.mapUrlToFilePath("/route1.html"), {
    statusCode: 404
  });

  t.deepEqual(server.mapUrlToFilePath("/route1/index.html"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route1/index.html")
  });

  server.close();
});

test("Url mappings for resource.html", t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/");

  t.deepEqual(server.mapUrlToFilePath("/route2/"), {
    statusCode: 301,
    url: "/route2"
  });

  t.deepEqual(server.mapUrlToFilePath("/route2/index.html"), {
    statusCode: 404
  });

  t.deepEqual(server.mapUrlToFilePath("/route2"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route2.html")
  });
  
  t.deepEqual(server.mapUrlToFilePath("/route2.html"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route2.html",)
  });

  server.close();
});

test("Url mappings for resource.html and resource/index.html", t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/");

  // Production mismatch warning: Netlify 301 redirects to /route3 here
  t.deepEqual(server.mapUrlToFilePath("/route3/"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route3/index.html",)
  });

  t.deepEqual(server.mapUrlToFilePath("/route3/index.html"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route3/index.html",)
  });

  t.deepEqual(server.mapUrlToFilePath("/route3"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route3.html")
  });
  
  t.deepEqual(server.mapUrlToFilePath("/route3.html"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route3.html",)
  });

  server.close();
});

test("Url mappings for missing resource", t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/");

  // 404s
  t.deepEqual(server.mapUrlToFilePath("/does-not-exist/"), {
    statusCode: 404
  });

  server.close();
});

test("Test standard request", async t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/", getOptions());
  server.serve(8080);

  let data = await makeRequestTo(t, server, "/sample");
  t.true(data.includes("<script "));
  t.true(data.startsWith("SAMPLE"));

  server.close();
});

test("Test one sync middleware", async t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/", getOptions({
    middleware: [
      function(req, res, next) {
        return next();
      }
    ],
  }));

  server.serve(8080);

  let data = await makeRequestTo(t, server, "/sample");
  t.true(data.includes("<script "));
  t.true(data.startsWith("SAMPLE"));

  server.close();
});

test("Test two sync middleware", async t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/", getOptions({
    middleware: [
      function(req, res, next) {
        return next();
      },
      function(req, res, next) {
        return next();
      }
    ],
  }));
  server.serve(8080);

  let data = await makeRequestTo(t, server, "/sample");
  t.true(data.includes("<script "));
  t.true(data.startsWith("SAMPLE"));

  server.close();
});

test("Test one async middleware", async t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/", getOptions({
    middleware: [
      async function(req, res, next) {
        return next();
      }
    ],
  }));
  server.serve(8080);

  let data = await makeRequestTo(t, server, "/sample");
  t.true(data.includes("<script "));
  t.true(data.startsWith("SAMPLE"));

  server.close();
});

test("Test two async middleware", async t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/", getOptions({
    middleware: [
      async function(req, res, next) {
        return next();
      },
      async function(req, res, next) {
        return next();
      }
    ],
  }));
  server.serve(8080);

  let data = await makeRequestTo(t, server, "/sample");
  t.true(data.includes("<script "));
  t.true(data.startsWith("SAMPLE"));

  server.close();
});

test("Test async middleware that writes", async t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/", getOptions({
    // enabled: false,
    middleware: [
      async function(req, res, next) {
        let data = await new Promise((resolve) => {
          setTimeout(() => {
            resolve("Injected")
          }, 10);
        });

        res.writeHead(200, {
          "Content-Type": "text/html",
        });
        res.write("Injected");
        res.end();
      },
    ],
  }));
  server.serve(8080);

  let data = await makeRequestTo(t, server, "/sample");
  t.true(data.includes("<script "));
  t.true(data.startsWith("Injected"));

  server.close();
});

test("Test second async middleware that writes", async t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/", getOptions({
    // enabled: false,
    middleware: [
      async function(req, res, next) {
        await new Promise((resolve) => {
          setTimeout(() => {
            resolve()
          }, 10);
        });

        next()
      },
      async function(req, res, next) {
        let data = await new Promise((resolve) => {
          setTimeout(() => {
            resolve("Injected")
          }, 10);
        });

        res.writeHead(200, {
          "Content-Type": "text/html",
        });
        res.write(data);
        res.end();
      },
    ],
  }));
  server.serve(8080);

  let data = await makeRequestTo(t, server, "/sample");
  t.true(data.includes("<script "));
  t.true(data.startsWith("Injected"));

  server.close();
});
