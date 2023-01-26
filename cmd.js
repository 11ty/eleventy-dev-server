#!/usr/bin/env node

const pkg = require("./package.json");

// Node check
require("please-upgrade-node")(pkg, {
  message: function (requiredVersion) {
    return (
      "eleventy-dev-server requires Node " +
      requiredVersion +
      ". You will need to upgrade Node!"
    );
  },
});

const { Logger, Cli } = require("./cli.js");

const debug = require("debug")("EleventyDevServer:cmd");

try {
  const argv = require("minimist")(process.argv.slice(2), {
    string: [
      "dir",
      "input", // alias for dir
      "port",
    ],
    boolean: [
      "version",
      "help",
      "domdiff",
    ],
    default: Cli.getDefaultOptions(),
    unknown: function (unknownArgument) {
      throw new Error(
        `We don’t know what '${unknownArgument}' is. Use --help to see the list of supported commands.`
      );
    },
  });

  debug("command: eleventy-dev-server %o", argv);

  process.on("unhandledRejection", (error, promise) => {
    Logger.fatal("Unhandled rejection in promise:", promise, error);
  });
  process.on("uncaughtException", (error) => {
    Logger.fatal("Uncaught exception:", error);
  });

  if (argv.version) {
    console.log(Cli.getVersion());
  } else if (argv.help) {
    console.log(Cli.getHelp());
  } else {
    let cli = new Cli();

    cli.serve({
      input: argv.dir || argv.input,
      port: argv.port,
      domDiff: argv.domdiff,
    });

    process.on("SIGINT", () => {
      cli.close();
      process.exit();
    });
  }
} catch (e) {
  Logger.fatal("Fatal Error:", e)
}
