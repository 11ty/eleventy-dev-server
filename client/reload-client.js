class Util {
  static pad(num, digits = 2) {
    let zeroes = new Array(digits + 1).join(0);
    return `${zeroes}${num}`.substr(-1 * digits);
  }

  static log(message) {
    Util.output("log", message);
  }
  static error(message, error) {
    Util.output("error", message, error);
  }
  static output(type, ...messages) {
    let now = new Date();
    let date = `${Util.pad(now.getUTCHours())}:${Util.pad(
      now.getUTCMinutes()
    )}:${Util.pad(now.getUTCSeconds())}.${Util.pad(
      now.getUTCMilliseconds(),
      3
    )}`;
    console[type](`[11ty][${date} UTC]`, ...messages);
  }

  static capitalize(word) {
    return word.substr(0, 1).toUpperCase() + word.substr(1);
  }

  static matchRootAttributes(htmlContent) {
    // Workaround for morphdom bug with attributes on <html> https://github.com/11ty/eleventy-dev-server/issues/6
    // Note also `childrenOnly: true` above
    const parser = new DOMParser();
    let parsed = parser.parseFromString(htmlContent, "text/html");
    let parsedDoc = parsed.documentElement;
    let newAttrs = parsedDoc.getAttributeNames();

    let docEl = document.documentElement;
    // Remove old
    let removedAttrs = docEl.getAttributeNames().filter(name => !newAttrs.includes(name));
    for(let attr of removedAttrs) {
      docEl.removeAttribute(attr);
    }

    // Add new
    for(let attr of newAttrs) {
      docEl.setAttribute(attr, parsedDoc.getAttribute(attr));
    }
  }

  static isEleventyLinkNodeMatch(from, to) {
    // Issue #18 https://github.com/11ty/eleventy-dev-server/issues/18
    // Don’t update a <link> if the _11ty searchParam is the only thing that’s different
    if(from.tagName !== "LINK" || to.tagName !== "LINK") {
      return false;
    }

    let oldWithoutHref = from.cloneNode();
    let newWithoutHref = to.cloneNode();
    
    oldWithoutHref.removeAttribute("href");
    newWithoutHref.removeAttribute("href");
    
    // if all other attributes besides href match
    if(!oldWithoutHref.isEqualNode(newWithoutHref)) {
      return false;
    }

    let oldUrl = new URL(from.href);
    let newUrl = new URL(to.href);

    // morphdom wants to force href="style.css?_11ty" => href="style.css"
    let isErasing = oldUrl.searchParams.has("_11ty") && !newUrl.searchParams.has("_11ty");
    if(!isErasing) {
      // not a match if _11ty has a new value (not being erased)
      return false;
    }

    oldUrl.searchParams.set("_11ty", "");
    newUrl.searchParams.set("_11ty", "");

    // is a match if erasing and the rest of the href matches too
    return oldUrl.toString() === newUrl.toString();
  }
}

class EleventyReload {
  static reconnect(e) {
    if (document.visibilityState === "visible") {
      EleventyReload.init({ mode: "reconnect" });
    }
  }

  static async onreload({ subtype, files, build }) {
    if (subtype === "css") {
      for (let link of document.querySelectorAll(`link[rel="stylesheet"]`)) {
        let url = new URL(link.href);
        url.searchParams.set("_11ty", Date.now());
        link.href = url.toString();
      }
      Util.log(`CSS updated without page reload.`);
    } else {
      let morphed = false;

      try {
        if((build.templates || []).length > 0) {
          // Important: using `./` in `./morphdom.js` allows the special `.11ty` folder to be changed upstream
          const { default: morphdom } = await import(`./morphdom.js`);

          for (let template of build.templates || []) {
            if (template.url === document.location.pathname) {
              // Importantly, if this does not match but is still relevant (layout/include/etc), a full reload happens below. This could be improved.
              if ((files || []).includes(template.inputPath)) {
                // Notable limitation: this won’t re-run script elements or JavaScript page lifecycle events (load/DOMContentLoaded)
                morphed = true;

                morphdom(document.documentElement, template.content, {
                  childrenOnly: true,
                  // Speed-up trick from morphdom docs
                  onBeforeElUpdated: function (fromEl, toEl) {
                    // https://dom.spec.whatwg.org/#concept-node-equals
                    if (fromEl.isEqualNode(toEl)) {
                      return false;
                    }

                    if(Util.isEleventyLinkNodeMatch(fromEl, toEl)) {
                      return false;
                    }

                    return true;
                  },
                });

                Util.matchRootAttributes(template.content);
                Util.log(`HTML delta applied without page reload.`);
              }
              break;
            }
          }
        }
      } catch(e) {
        Util.error( "Morphdom error", e );
      }

      if (!morphed) {
        Util.log(`Page reload initiated.`);
        window.location.reload();
      }
    }
  }

  static init(options = {}) {
    if (!("WebSocket" in window)) {
      return;
    }

    Util.log("Trying to connect…");

    let { protocol, host } = new URL(document.location.href);
    let websocketProtocol = protocol.replace("http", "ws");
    // TODO add a path here so that it doesn’t collide with any app websockets
    let socket = new WebSocket(`${websocketProtocol}//${host}`);

    // TODO add special handling for disconnect or document focus to retry
    socket.addEventListener("message", async function (event) {
      try {
        let data = JSON.parse(event.data);
        // Util.log( JSON.stringify(data, null, 2) );
        let { type } = data;

        if (type === "eleventy.reload") {
          await EleventyReload.onreload(data);
        } else if (type === "eleventy.msg") {
          Util.log(`${data.message}`);
        } else if (type === "eleventy.error") {
          // Log Eleventy build errors
          // Extra parsing for Node Error objects
          let e = JSON.parse(data.error);
          Util.error(`Build error:  ${e.message}`, e);
        } else if (type === "eleventy.status") {
          // Full page reload on initial reconnect
          if (data.status === "connected" && options.mode === "reconnect") {
            window.location.reload();
          }

          Util.log(Util.capitalize(data.status));
        } else {
          Util.log("Unknown event type", data);
        }
      } catch (e) {
        Util.log("Error", event.data, e.message);
      }
    });

    socket.addEventListener("open", (event) => {
      EleventyReload.applyReconnectListeners("remove");
    });

    socket.addEventListener("close", (event) => {
      EleventyReload.applyReconnectListeners("remove");
      EleventyReload.applyReconnectListeners("add");
    });
  }

  static applyReconnectListeners(mode) {
    let method = "addEventListener";
    if (mode === "remove") {
      method = "removeEventListener";
    }
    window[method]("focus", EleventyReload.reconnect);
    window[method]("visibilitychange", EleventyReload.reconnect);
  }
}

// TODO remove this?
// Util.log("Page reload.", Date.now());

EleventyReload.init();
