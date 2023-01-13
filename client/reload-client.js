class Util {
  static pad(num, digits = 2) {
    let zeroes = new Array(digits + 1).join(0);
    return `${zeroes}${num}`.slice(-1 * digits);
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

  // https://github.com/patrick-steele-idem/morphdom/issues/178#issuecomment-652562769
  static runScript(source, target) {
    let script = document.createElement('script');

    //copy over the attributes
    for(let attr of [...source.attributes]) {
      script.setAttribute(attr.nodeName ,attr.nodeValue);
    }

    script.innerHTML = source.innerHTML;
    (target || source).replaceWith(script);
  }
}

class EleventyReload {
  constructor() {
    this.connectionMessageShown = false;
    this.reconnectEventCallback = this.reconnect.bind(this);
  }

  init(options = {}) {
    if (!("WebSocket" in window)) {
      return;
    }

    let { protocol, host } = new URL(document.location.href);

    // works with http (ws) and https (wss)
    let websocketProtocol = protocol.replace("http", "ws");

    let socket = new WebSocket(`${websocketProtocol}//${host}`);

    socket.addEventListener("message", async (event) => {
      try {
        let data = JSON.parse(event.data);
        // Util.log( JSON.stringify(data, null, 2) );

        let { type } = data;

        if (type === "eleventy.reload") {
          await this.onreload(data);
        } else if (type === "eleventy.msg") {
          Util.log(`${data.message}`);
        } else if (type === "eleventy.error") {
          // Log Eleventy build errors
          // Extra parsing for Node Error objects
          let e = JSON.parse(data.error);
          Util.error(`Build error: ${e.message}`, e);
        } else if (type === "eleventy.status") {
          // Full page reload on initial reconnect
          if (data.status === "connected" && options.mode === "reconnect") {
            window.location.reload();
          }

          if(data.status === "connected") {
            // With multiple windows, only show one connection message
            if(!this.isConnected) {
              Util.log(Util.capitalize(data.status));
            }

            this.connectionMessageShown = true;
          } else {
            if(data.status === "disconnected") {
              this.addReconnectListeners();
            }

            Util.log(Util.capitalize(data.status));
          }
        } else {
          Util.log("Unknown event type", data);
        }
      } catch (e) {
        Util.error(`Error parsing ${event.data}: ${e.message}`, e);
      }
    });

    socket.addEventListener("open", () => {
      // no reconnection when the connect is already open
      this.removeReconnectListeners();
    });
    
    socket.addEventListener("close", () => {
      this.connectionMessageShown = false;
      this.addReconnectListeners();
    });
  }

  reconnect() {
    Util.log( "Reconnecting…" );
    this.init({ mode: "reconnect" });
  }

  async onreload({ subtype, files, build }) {
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

          // { url, inputPath, content }
          for (let template of build.templates || []) {
            if (template.url === document.location.pathname) {
              // Importantly, if this does not match but is still relevant (layout/include/etc), a full reload happens below. This could be improved.
              if ((files || []).includes(template.inputPath)) {
                // Notable limitation: this won’t re-run script elements or JavaScript page lifecycle events (load/DOMContentLoaded)
                morphed = true;

                morphdom(document.documentElement, template.content, {
                  childrenOnly: true,
                  onBeforeElUpdated: function (fromEl, toEl) {
                    if (fromEl.nodeName === "SCRIPT" && toEl.nodeName === "SCRIPT") {
                      Util.runScript(toEl, fromEl);
                      return false;
                    }

                    // Speed-up trick from morphdom docs
                    // https://dom.spec.whatwg.org/#concept-node-equals
                    if (fromEl.isEqualNode(toEl)) {
                      return false;
                    }

                    if(Util.isEleventyLinkNodeMatch(fromEl, toEl)) {
                      return false;
                    }

                    return true;
                  },
                  onNodeAdded: function (node) {
                    if (node.nodeName === 'SCRIPT') {
                      Util.runScript(node);
                    }
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

  addReconnectListeners() {
    this.removeReconnectListeners();

    window.addEventListener("focus", this.reconnectEventCallback);
    window.addEventListener("visibilitychange", this.reconnectEventCallback);
  }

  removeReconnectListeners() {
    window.removeEventListener("focus", this.reconnectEventCallback);
    window.removeEventListener("visibilitychange", this.reconnectEventCallback);
  }
}

let reloader = new EleventyReload();
reloader.init();