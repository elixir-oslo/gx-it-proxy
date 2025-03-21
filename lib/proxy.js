const http = require("http"),
  httpProxy = require("http-proxy");

const bound = function(that, method) {
  // bind a method, to ensure `this=that` when it is called
  // because prototype languages are bad
  return function() {
    method.apply(that, arguments);
  };
};

const DynamicProxy = function(options) {
  var dynamicProxy = this;
  this.sessionCookie = options.sessionCookie;
  this.sessionMap = options.sessionMap;
  this.debug = options.verbose;
  this.reverseProxy = options.reverseProxy;
  this.port = options.port;
  this.forwardIP = options.forwardIP;
  this.forwardPort = options.forwardPort;
  this.proxyPathPrefix = options.proxyPathPrefix;

  var log_errors = function(handler) {
    return function(req) {
      try {
        return handler.apply(dynamicProxy, arguments);
      } catch (e) {
        console.log(
          "Error in handler for " +
            req.headers.host +
            " " +
            req.method +
            " " +
            req.url +
            ": ",
          e
        );
      }
    };
  };

  this.proxy = httpProxy.createProxyServer({
    ws: true
  });

  this.proxy_server = http.createServer(
    log_errors(dynamicProxy.handleProxyRequest)
  );
  this.proxy_server.on("upgrade", bound(this, this.handleWs));
};

DynamicProxy.prototype.rewriteRequest = function(request) {
  if (request.url.indexOf("rstudio") != -1) {
    var remap = {
      "content-type": "Content-Type",
      "content-length": "Content-Length"
    };
    // RStudio isn't spec compliant and pitches a fit on NodeJS's http module's lowercase HTTP headers
    for (var i = 0; i < Object.keys(remap).length; i++) {
      var key = Object.keys(remap)[i];
      if (key in request.headers) {
        request.headers[remap[key]] = request.headers[key];
        delete request.headers[key];
      }
    }
    if (
      "Content-Type" in request.headers &&
      request.headers["Content-Type"] ==
        "application/x-www-form-urlencoded; charset=UTF-8"
    ) {
      request.headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
  }
};

DynamicProxy.prototype.targetFromSessionMap = function(key, token) {
  for (let mappedSession in this.sessionMap) {
    if (key == mappedSession) {
      if (this.sessionMap[key].token == token) {
        return this.sessionMap[key].target;
      }
    }
  }
};

DynamicProxy.prototype.targetFromHeaders = function(request) {
  let host = request.headers["x-interactive-tool-host"];
  let port = request.headers["x-interactive-tool-port"];
  if (!port && host.indexOf(":") > 0) {
    const res = host.split(":", 2);
    host = res[0];
    port = res[1];
  }
  return {
    host: host,
    port: parseInt(port)
  };
};

DynamicProxy.prototype.targetForRequest = function(request) {
  // return proxy target for a given url

  // extract key and token from subdomain if domain-based
  const req_host = request.headers.host;
  let key = req_host.substring(0, req_host.indexOf("-"));
  let token = req_host.substring(
    req_host.indexOf("-") + 1,
    req_host.indexOf(".")
  );

  // extract key, token, and target_url from path if path-based
  if (!(token && key) && this.proxyPathPrefix && request.url.startsWith(this.proxyPathPrefix)) {
      console.log('Using proxyPathPrefix: ' + this.proxyPathPrefix + ' for url: ' + request.url);
      const rest_path = request.url.substring(this.proxyPathPrefix.length);
      console.assert(rest_path.startsWith('/'))
      const path_split = rest_path.split('/')
      key = path_split[1];
      token = path_split[2];
      const target_url = "/" + path_split.slice(3).join("/");
      console.log(key + " - " + token + " " + target_url);
      request.url = target_url;
  }

  let target;
  if (this.sessionMap) {
    target = this.targetFromSessionMap(key, token);
  } else {
    target = this.targetFromHeaders(request);
  }

  if (target) {
    return target;
  }

  if (this.debug) {
    console.log(
      "No target found for " +
        req_host +
        " " +
        request.method +
        " " +
        request.url
    );
  }
  return null;
};

DynamicProxy.prototype.configureForward = function(req, target) {
  var _target = Object.assign({}, target);
  if (this.forwardIP) {
    console.log(
      "Forwarding request for " + target.host + " to " + this.forwardIP
    );
    req.headers["x-interactive-tool-host"] = target.host;
    _target.host = this.forwardIP;
  } else {
    delete req.headers["x-interactive-tool-host"];
  }
  if (this.forwardPort) {
    console.log(
      "Forwarding request for " + target.port + " to " + this.forwardPort
    );
    req.headers["x-interactive-tool-port"] = target.port;
    _target.port = this.forwardPort;
  } else {
    delete req.headers["x-interactive-tool-port"];
  }
  return _target;
};

DynamicProxy.prototype.handleProxyRequest = function(req, res) {
  var othis = this;
  var target = this.targetForRequest(req);
  if (this.debug && target) {
    console.log(
      "PROXY " +
        req.headers.host +
        " " +
        req.method +
        " " +
        req.url +
        " to " +
        target.host +
        ":" +
        target.port
    );
  }
  var origin = req.headers.origin;
  this.rewriteRequest(req);
  res.oldWriteHead = res.writeHead;

  res.writeHead = function(statusCode, headers) {
    if (othis.reverseProxy && statusCode === 302) {
      if (res && res._headers) {
        if (othis.debug) {
          console.log("Original Location Header: " + res._headers.location);
        }
        if (res._headers.location) {
          res._headers.location = res._headers.location.replace(
            "http://localhost/",
            "http://localhost:" + othis.port + "/"
          );
        }
        if (othis.debug) {
          console.log("Rewritten Location Header: " + res._headers.location);
        }
      }
    }
    try {
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
      }
      res.setHeader("Access-Control-Allow-Credentials", "true");

      if (!headers) {
        headers = {};
      }
      res.oldWriteHead(statusCode, headers);
    } catch (error) {
      console.log("Header could not be modified.");
      console.log(error);
    }
  };
  target = this.configureForward(req, target);
  this.proxy.web(
    req,
    res,
    {
      target: target
    },
    function(e) {
      console.log("Proxy error: ", e);
      res.writeHead(502);
      res.write("Proxy target missing");
      res.end();
    }
  );
};

DynamicProxy.prototype.handleWs = function(req, res, head) {
  // no local route found, time to proxy
  var target = this.targetForRequest(req);
  if (this.debug && target) {
    console.log(
      "PROXY WS " + req.url + " to " + target.host + ":" + target.port
    );
  }
  var origin = req.headers.origin;
  this.rewriteRequest(req);
  res.oldWriteHead = res.writeHead;
  res.writeHead = function(statusCode, headers) {
    try {
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
      }
      res.setHeader("Access-Control-Allow-Credentials", "true");
      if (!headers) {
        headers = {};
      }
      res.oldWriteHead(statusCode, headers);
    } catch (error) {
      console.log("Header could not be modified.");
      console.log(error);
    }
  };
  target = this.configureForward(req, target);
  this.proxy.ws(
    req,
    res,
    head,
    {
      target: target
    },
    function(e) {
      console.log("Proxy error: ", e);
      res.writeHead(502);
      res.write("Proxy target missing");
      res.end();
    }
  );
};

DynamicProxy.prototype.listen = function(args_) {
  const args = args_ || {};
  const port = this.port || 8000;
  const ip = args.ip || "localhost";
  if (this.debug) {
    console.log("Listening on " + ip + ":" + port);
  }
  this.proxy_server.listen(port, ip);
};

DynamicProxy.prototype.close = function() {
  this.proxy.close();
  this.proxy_server.close();
};

exports.DynamicProxy = DynamicProxy;
