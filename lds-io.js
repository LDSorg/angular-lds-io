angular
  .module('lds.io.storage', [])
  .service('LdsApiStorage', [
    '$window'
  , '$q'
  , function LdsApiStorage($window, $q) {
    var prefix = 'io.lds.';
    var LdsIoStorage = {
      init: function (pre) {
        if (pre) {
          prefix = pre;
        }
      }
    , get: function (key) {
        var val;

        try {
          val = JSON.parse(localStorage.getItem(prefix + key) || null);
        } catch(e) {
          localStorage.removeItem(prefix + key);
          val = null;
        }

        // just because sometimes it happens...
        if ('undefined' === val || 'null' === val) {
          console.warn("got undefined for " + prefix + key);
          val = null;
        }

        return $q.when(val);
      }
    , set: function (key, val) {
        try {
          localStorage.setItem(prefix + key, JSON.parse(val));
          return $q.when();
        } catch(e) {
          console.error("couldn't parse " + prefix + key, localStorage.getItem(prefix + key));
          return $q.reject(e);
        }
      }
    , clear: function (account) {
        var re;
        var keys = [];
        var i;
        var key;

        re = new RegExp('^'
          // See http://stackoverflow.com/a/6969486/151312 for regexp escape explanation
          + prefix.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&")
          + (account || '')
        );

        for (i = 0; i < localStorage.length; i += 1) {
          key = localStorage.key(i);
          if (re.test(key)) {
            keys.push(key);
          }
        }

        keys.forEach(function (key) {
          localStorage.removeItem(key);
        });

        return $q.when();
      }
    };

    // for easier debugging :)
    $window.LdsIo = $window.LdsIo || {};
    $window.LdsIo.storage = LdsIoStorage;

    return LdsIoStorage;
  }])
  ;
'use strict';

angular
  .module('lds.io.config', ['lds.io.storage'])
  .service('LdsApiConfig', [
    '$window'
  , 'LdsApiStorage'
  , function LdsApiConfig($window, LdsApiStorage) {
    var defaults = {
      providerUri: 'https://lds.io'
    , appId: null
    , apiPrefix: '/api/ldsio'
    , refreshWait: 15 * 60 * 60 * 1000
    , uselessWait: Infinity
    , loginHandler: function () {
        $window.alert("override `LdsApiConfig.loginHandler` with a function that shows a login dialog,"
          + " calls LdsApiSession.login on click, and returns a promise in that chain."
          + " TODO document on website");
      }
    };
    var LdsIoConfig = {
      init: function (opts) {
        var me = this;

        opts = opts || {};
        return LdsApiStorage.get('providerUri').then(function (val) {
          me.providerUri = val;
          me.developerMode = true;
        }, function () {
          // ignore
        }).then(function () {
          Object.keys(opts).forEach(function (key) {
            if ('appSecret' === key) {
              $window.alert("[ERROR] appSecret must never be used in a client (browser, mobile, or desktop)");
              return;
            }
            me[key] = opts[key];
          });

          Object.keys(defaults).forEach(function (key) {
            if (undefined === typeof me[key]) {
              me[key] = defaults[key];
            }
          });

          if (!me.appId) {
            // TODO auto-register oauth3
            $window.alert("[ERROR] you did not supply `LdsApiConfig.appId`. Consider using 'TEST_ID_9e78b54c44a8746a5727c972'");
          }
        });
      }
    };

    // for easier debugging :)
    $window.LdsIo = $window.LdsIo || {};
    $window.LdsIo.config = LdsIoConfig;

    return LdsIoConfig;
  }])
  ;
'use strict';

angular
  .module('lds.io.cache', ['lds.io.storage'])
  .service('LdsApiCache', [
    '$window'
  , '$q'
  , 'LdsApiStorage'
  , function LdsApiCache($window, $q, LdsApiStorage) {
    var LdsIoCache;
    var caches;
    var refreshIn = (15 * 60 * 1000);
    var uselessIn = Infinity; // (30 * 24 * 60 * 60 * 1000);

    /*
    function batchApiCall(ids, url, handler) {
      // freshIds, staleIds = ids.filter()
      // get url but don't cache
      handler(result, function (id, data) {
        // put id into result set
      });
    }
    */

    function init() {
      return LdsApiStorage.get('caches').then(function (result) {
        caches = result || {};
        return;
      });
    }

    function apiCall(id, url, fetch, opts) {
      var refreshWait = refreshIn;
      var uselessWait = uselessIn;
      var fresh;
      var usable;
      var now;
      var promise;

      function fin(value) {
        promise = null;
        caches[id] = Date.now();
        return LdsApiStorage.set(id, value).then(function () {
          return LdsApiStorage.set('caches', caches).then(function () {
            return { updated: caches[id], value: value, stale: false };
          });
        });
      }

      if (caches[id] && !(opts && opts.expire)) {
        now = Date.now();
        usable = now - caches[id] < uselessWait;
        fresh = now - caches[id] < refreshWait;
        if (!fresh) {
          promise = fetch().then(fin);
        }
      }

      return LdsApiStorage.get(id).then(function (result) {
        // TODO reject on missing?
        if (!result) {
          return (promise || fetch()).then(fin);
        }

        if (usable) {
          return $q.when({ updated: caches[id], value: result, stale: !fresh });
        } else {
          return (promise || fetch()).then(fin);
        }
      }, function () {
        return (promise || fetch()).then(fin);
      });
    }

    function destroy() {
      caches = {};
      return LdsApiStorage.clear();
    }

    LdsIoCache = {
      init: init
    , read: apiCall
    , destroy: destroy
    };

    // for easier debugging :)
    $window.LdsIo = $window.LdsIo || {};
    $window.LdsIo.cache = LdsIoCache;

    return LdsIoCache;
  }])
  ;
'use strict';

angular
  .module('lds.io.session', ['lds.io.cache', 'lds.io.storage', 'lds.io.config'])
  .service('LdsApiSession', [
    '$window'
  , '$timeout'
  , '$q'
  , '$http'
  , 'LdsApiConfig'
  , 'LdsApiStorage'
  , 'LdsApiCache'
  , function LdsApiSession($window, $timeout, $q, $http, LdsApiConfig, LdsApiStorage, LdsApiCache) {
    var shared = { session: {} };
    var apiPrefix;
    var providerBase;
    //var oauthPrefix = providerBase + '/api/oauth3';
    var logins = {};
    var myAppDomain;
    var myAppId;
    
    // note: host includes 'port' when port is non-80 / non-443
    myAppDomain = $window.location.protocol + '//' + $window.location.host;
    myAppDomain += $window.location.pathname;

    // TODO track granted scopes locally
    function save(session) {
      localStorage.setItem('io.lds.session', JSON.stringify(session));
      return $q.when(session);
    }

    function restore() {
      // Being very careful not to trigger a false onLogin or onLogout via $watch
      var storedSession;

      if (shared.session.token) {
        return $q.when(shared.session);
      }

      storedSession = JSON.parse(localStorage.getItem('io.lds.session') || null) || {};

      if (storedSession.token) {
        shared.session = storedSession;
        return $q.when(shared.session);
      } else {
        return $q.reject(new Error("No Session"));
      }
    }

    function destroy() {
      if (!shared.session.token) {
        return $q.when(shared.session);
      }

      shared.session = {};
      localStorage.removeItem('io.lds.session');
      return LdsApiCache.destroy().then(function (session) {
        return session;
      });
    }

    function testToken(session) {
      // TODO cache this also, but with a shorter shelf life?
      return $http.get(
        apiPrefix + '/accounts'
      , { headers: { 'Authorization': 'Bearer ' + session.token } }
      ).then(function (resp) {
        var accounts = resp.data && resp.data.accounts || resp.data;
        var id;

        // TODO accounts should be an object
        // (so that the type doesn't change on error)
        if (!Array.isArray(accounts) || accounts.error) { 
          console.error("ERR acc", accounts);
          return $q.reject(new Error("could not verify session")); // destroy();
        }

        if (1 !== accounts.length) {
          console.error("SCF acc.length", accounts.length);
          return $q.reject(new Error("[SANITY CHECK FAILED] number of accounts: '" + accounts.length + "'"));
        }

        id = accounts[0].app_scoped_id || accounts[0].id;

        if (!id) {
          console.error("SCF acc[0].id", accounts);
          return $q.reject(new Error("[SANITY CHECK FAILED] could not get account id"));
        }

        session.id = id;
        session.ts = Date.now();

        return session;
      });
    }

    function logout() {
      // TODO also logout of lds.io
      /*
      return $http.delete(
        apiPrefix + '/session'
      , { headers: { 'Authorization': 'Bearer ' + shared.session.token } }
      ).then(function () {
        return destroy();
      });
      */

      var url = providerBase + '/logout.html'
      var $iframe = $('<iframe src="' + url + '" width="1px" height="1px" style="opacity: 0.01;" frameborder="0"></iframe>');
      $('body').append($iframe);
      
      return $timeout(function () {
        $iframe.remove();
      }, 500).then(function () {
        destroy();
      });
    }

    function init(appId) {
      myAppId = appId;
      providerBase = localStorage.getItem('providerUri') || 'https://lds.io';
      apiPrefix = providerBase + '/api/ldsio';
      console.warn("TODO set UI flag with notice when in developer mode");
      // TODO delete stale sessions (i.e. on public computers)
    }

    function backgroundLogin() {
      return restore().then(function (session) {
        // TODO check expirey
        return testToken(session);
      }, function () {
        silentLogin();
        return;
      });
    }

    function parseLogin(name, url) {
      // TODO return granted_scope and expires_at

      var tokenMatch = url.match(/(^|\#|\?|\&)access_token=([^\&]+)(\&|$)/);
      var idMatch = url.match(/(^|\#|\?|\&)id=([^\&]+)(\&|$)/);
      var token;
      var id;

      if (tokenMatch) {
        token = tokenMatch[2];
      }

      if (idMatch) {
        id = idMatch[2];
      }

      return { token: token, id: id };
    }

    $window.completeLogin = function (name, url) {
      var params = parseLogin(name, url);
      var d = logins[params.id];

      if (!params.id) {
        throw new Error("could not parse id from login");
      }

      if (!params.token) {
        return $q.reject(new Error("didn't get token")); // destroy();
      }

      shared.session.token = params.token;
      // TODO rid token on reject
      return testToken(shared.session).then(save).then(d.resolve, d.reject);
    };

    function createLogin(d, oauthscope) {
      var requestedScope = oauthscope || ['me'];
      var id = Math.random().toString().replace(/0\./, '');
      logins[id] = d;

      var url = providerBase + '/api/oauth3/authorization_dialog'
        + '?response_type=token'
        + '&client_id=' + myAppId
          // TODO use referrer?
        + '&redirect_uri='
            + encodeURIComponent(myAppDomain + '/oauth-close.html?id=' + id + '&type=/providers/ldsio/callback/')
        + '&scope=' + encodeURIComponent(requestedScope.join(' '))
        + '&state=' + Math.random().toString().replace(/^0./, '')
        ;

      return url;
    }

    // This is for client-side (implicit grant) oauth2
    function silentLogin(oauthscope) {
      if (silentLogin._inProgress) {
        return silentLogin._inProgress;
      }

      var d = $q.defer();
      var url = createLogin(d, oauthscope); // resolves in createLogin
      var $iframe = $('<iframe src="' + url + '" width="1px" height="1px" style="opacity: 0.01;" frameborder="0"></iframe>');

      function removeIframe(data) {
        silentLogin._inProgress = null;
        $iframe.remove();
        return data;
      }

      function removeIframeErr(err) {
        silentLogin._inProgress = null;
        $iframe.remove();
        return $q.reject(err);
      }

      $('body').append($iframe);

      silentLogin._inProgress = d.promise.then(removeIframe, removeIframeErr);

      return silentLogin._inProgress;
    }

    function login(oauthscope, opts) {
      // TODO note that this must be called on a click event
      // otherwise the browser will block the popup
      function forceLogin() {
        var d = $q.defer();
        var url = createLogin(d, oauthscope);

        // This is for client-side (implicit grant) oauth2
        $window.open(url, 'ldsioLogin', 'height=720,width=620');

        return d.promise;
      }

      return checkSession().then(function (session) {
        if (!session.id || opts && opts.force) {
          return forceLogin();
        }

        return session;
      }, forceLogin);
    }

    function requireSession() {
      return restore().then(function (session) {
        return session;
      }, function (/*err*/) {
        
        return LdsApiConfig.loginHandler();
      });
    }

    function checkSession() {
      return restore();
    }

    function onLogin(_scope, fn) {
      // This is better than using a promise.notify
      // because the watches will unwatch when the controller is destroyed
      _scope.__stsessionshared__ = shared;
      _scope.$watch('__stsessionshared__.session', function (newValue, oldValue) {
        if (!oldValue.id && newValue.id) {
          fn(shared.session);
        }
      }, true);
    }

    function onLogout(_scope, fn) {
      _scope.__stsessionshared__ = shared;
      _scope.$watch('__stsessionshared__.session', function (newValue, oldValue) {
        if (oldValue.token && !newValue.token) {
          fn(null);
        }
      }, true);
    }

    return {
      init: init
    , restore: restore
    , destroy: destroy
    , login: login
    , logout: logout
    , onLogin: onLogin
    , onLogout: onLogout
    , checkSession: checkSession
    , requireSession: requireSession
    , backgroundLogin: backgroundLogin
    };
  }])
  ;
'use strict';

angular
  .module('lds.io.api', ['lds.io.cache', 'lds.io.config'])
  .service('LdsApiRequest', [
    '$window'
  , '$timeout'
  , '$q'
  , '$http'
  , 'LdsApiConfig'
  , 'LdsApiCache'
  , function LdsApiRequest($window, $timeout, $q, $http, LdsApiConfig, LdsApiCache) {
    var LdsIoApi;
    var providerBase;
    var apiPrefix;
    var promises = {};

    function realGet(session, id, url) {
      if (promises[id]) {
        return promises[id];
      }

      promises[id] = $http.get(
        url
      , { headers: { 'Authorization': 'Bearer ' + session.token } }
      ).then(function (resp) {
        delete promises[id];

        if (!resp.data) {
          window.alert("[SANITY FAIL] '" + url + "' returned nothing (not even an error)");
          return;
        }

        if (resp.data.error) {
          console.error('[ERROR]', url);
          console.error(resp.data);
          window.alert("[DEVELOPER ERROR] '" + url + "' returned an error (is the url correct? did you check login first?)");
          return;
        }


        return resp.data;
      }, function (err) {
        delete promises[id];

        return $q.reject(err);
      });

      return promises[id];
    }

    function promiseApiCall(session, id, url, opts) {
      opts = opts || {};
      return LdsApiCache.read(id, url, function () {
        var d = $q.defer();

        var token = $timeout(function () {
          if (opts.tried) {
            d.reject(new Error("timed out (twice) when attempting to get data"));
            return;
          }

          opts.tried = true;
          return promiseApiCall(session, id, url, opts).then(d.resolve, d.reject);
        }, opts.tried && 16000 || 8000); 

        realGet(session, id, url).then(function (data) {
          $timeout.cancel(token);
          return d.resolve(data);
        }, function (err) {
          $timeout.cancel(token);
          return d.reject(err);
        });

        return d.promise;
      }, opts).then(function (data) {
        return data.value;
      });
    }

    LdsIoApi = {
      init: function () {
        providerBase = localStorage.getItem('providerUri') || 'https://lds.io';
        apiPrefix = providerBase + '/api/ldsio';
        console.info("API set to " + providerBase);
        console.log("set to custom provider with `localStorage.setItem('providerUri', 'https://example.com')`");
        console.log("or set to default with `localStorage.removeItem('providerUri')`");
      }
    , profile: function (session, opts) {
        var id = session.id + '.me';
        var url = apiPrefix + '/' + session.id + '/me';

        return promiseApiCall(
          session
        , id
        , url
        , opts
        );
      }
    , stake: function (session, stakeId, opts) {
        var id = session.id + 'stake.' + stakeId;
        var url = apiPrefix + '/' + session.id + '/stakes/' + stakeId;

        return promiseApiCall(
          session
        , id
        , url
        , opts
        );
      }
    , stakePhotos: function (session, stakeId, opts) {
        var id = session.id + 'stake.' + stakeId;
        var url = apiPrefix + '/' + session.id + '/stakes/' + stakeId + '/photos';

        return promiseApiCall(
          session
        , id
        , url
        , opts
        );
      }
    , ward: function (session, stakeId, wardId, opts) {
        var id = session.id + 'stake.' + stakeId + '.ward.' + wardId;
        var url = apiPrefix + '/' + session.id + '/stakes/' + stakeId + '/wards/' + wardId;

        return promiseApiCall(
          session
        , id
        , url
        , opts
        );
      }
    , wardPhotos: function (session, stakeId, wardId, opts) {
        var id = session.id + 'stake.' + stakeId + '.ward.' + wardId + '.photos';
        var url = apiPrefix + '/' + session.id + '/stakes/' + stakeId + '/wards/' + wardId + '/photos';

        return promiseApiCall(
          session
        , id
        , url
        , opts
        );
      }
    , photoUrl: function (session, photo, size, type) {
        // https://lds.io/api/ldsio/<accountId>/photos/individual/<appScopedId>/<date>/medium/<whatever>.jpg
        return apiPrefix + '/' + session.id 
          + '/photos/' + (type || photo.type)
          + '/' + (photo.app_scoped_id || photo.id) + '/' + (photo.updated_at || 'bad-updated-at')
          + '/' + (size || 'medium') + '/' + (photo.app_scoped_id || photo.id) + '.jpg'
          + '?access_token=' + session.token
          ;
      }
    , guessGender: function (m) {
        var men = [ 'highPriest', 'high_priest', 'highpriest', 'elder', 'priest', 'teacher', 'deacon' ];
        var women = [ 'reliefSociety', 'relief_society', 'reliefsociety', 'laurel', 'miamaid', 'beehive' ];

        if (men.some(function (thing) {
          return m[thing];
        })) {
          return 'male';
        }

        if (women.some(function (thing) {
          return m[thing];
        })) {
          return 'female';
        }
      }
    };

    // for easier debugging :)
    $window.LdsIo = $window.LdsIo || {};
    $window.LdsIo.api = LdsIoApi;

    return LdsIoApi;
  }])
  ;
'use strict';

angular
  .module('lds.io', ['lds.io.api', 'lds.io.session', 'lds.io.cache', 'lds.io.storage'])
  ;

