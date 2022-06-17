<p align="center"><img src="https://www.11ty.dev/img/logo-github.svg" width="200" height="200" alt="11ty Logo"></p>

# eleventy-dev-server 🕚⚡️🎈🐀

A minimal, modern, generic, hot-reloading local web server to help web developers.

## ➡ [Documentation](https://www.11ty.dev/docs/watch-serve/#eleventy-dev-server)

- Please star [Eleventy on GitHub](https://github.com/11ty/eleventy/)!
- Follow us on Twitter [@eleven_ty](https://twitter.com/eleven_ty)
- Support [11ty on Open Collective](https://opencollective.com/11ty)
- [11ty on npm](https://www.npmjs.com/org/11ty)
- [11ty on GitHub](https://github.com/11ty)

[![npm Version](https://img.shields.io/npm/v/@11ty/eleventy-dev-server.svg?style=for-the-badge)](https://www.npmjs.com/package/@11ty/eleventy-dev-server)

## Installation

You _do not need to install this_ separately—it is bundled with `@11ty/eleventy` starting with Eleventy v2.0.0.

## CLI

As of `1.0.0-canary.10` we now include a CLI for the Eleventy Dev Server.

This is for **standalone** use only. Installation is unnecessary if you’re using this with Eleventy.

```sh
npm install -g @11ty/eleventy-dev-server

# Alternatively, install locally into your project
npm install @11ty/eleventy-dev-server
```

### CLI Usage

```sh
# Serve the current directory
npx @11ty/eleventy-dev-server

# Serve a different subdirectory
npx @11ty/eleventy-dev-server --input=_site

# Disable the `domdiff` feature
npx @11ty/eleventy-dev-server --domdiff=false

# Full command list in the Help
npx @11ty/eleventy-dev-server --help
```

## Tests

```
npm run test
```

- We use the [ava JavaScript test runner](https://github.com/avajs/ava) ([Assertions documentation](https://github.com/avajs/ava/blob/master/docs/03-assertions.md))
