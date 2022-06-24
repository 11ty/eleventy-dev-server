const test = require("ava");
const path = require("path");
const EleventyDevServer = require("../");

function testNormalizeFilePath(filepath) {
  return filepath.split("/").join(path.sep);
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

test("Url mapping for a filename with a space in it", t => {
  let server = new EleventyDevServer("test-server", "./test/stubs/");

  t.deepEqual(server.mapUrlToFilePath("/route space.html"), {
    statusCode: 200,
    filepath: testNormalizeFilePath("test/stubs/route space.html",)
  });

  server.close();
});

test("matchPassthroughAlias", async (t) => {
  let server = new EleventyDevServer("test-server", "./test/stubs/");

  // url => project root input
  server.setAliases({
    // works with directories
    "/img": "./test/stubs/img",
    "/elsewhere": "./test/stubs/alternative",
    // or full paths
    "/elsewhere/index.css": "./test/stubs/with-css/style.css",
  });

  // No map entry
  t.is(server.matchPassthroughAlias("/"), false);
  t.is(server.matchPassthroughAlias("/index.html"), false); // file exists

  // File exists
  t.is(server.matchPassthroughAlias("/elsewhere"), "./test/stubs/alternative");
  t.is(server.matchPassthroughAlias("/elsewhere/test"), "./test/stubs/alternative/test");

  // Map entry exists but file does not exist
  t.is(server.matchPassthroughAlias("/elsewhere/test.png"), false);
  t.is(server.matchPassthroughAlias("/elsewhere/another.css"), false);
  
  // Map entry exists, file exists
  t.is(server.matchPassthroughAlias("/elsewhere/index.css"), "./test/stubs/with-css/style.css");
});
