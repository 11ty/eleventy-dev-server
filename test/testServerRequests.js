const test = require("ava");
const path = require("path");
const http = require("http");
const EleventyDevServer = require("../");

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
