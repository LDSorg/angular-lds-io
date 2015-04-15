'use strict';

angular
  .module('lds.io.session', ['oauth3', 'lds.io.cache', 'lds.io.storage', 'lds.io.config'])
  .service('LdsApiSession', [
    '$window'
  , '$timeout'
  , '$q'
  , '$http'
  , 'LdsApiConfig'
  , 'LdsApiStorage'
  , 'LdsApiCache'
  , 'Oauth3'
  , function LdsApiSession($window, $timeout, $q, $http
      , LdsApiConfig, LdsApiStorage, LdsApiCache, Oauth3) {

    function createSession() {
      return { logins: [], accounts: [] };
    }

    var shared = { session: createSession() };
    var logins = {};
    var loginPromises = {};
    var foregroundLoginPromises = {};
    var backgroundLoginPromises = {};
    var LdsIoSession;

    $window.completeLogin = function (_, __, params) {
      var state = params.browser_state || params.state;
      var stateParams = Oauth3.states[state];
      // TODO nix other progressPromises?
      var d = loginPromises[state];

      function closeWindow() {
        if (d.winref) {
          d.winref.close(); 
        }
        if (d.$iframe) {
          d.$iframe.remove();
        }
      }

      d.promise.then(closeWindow).catch(closeWindow);

      if (!state) {
        d.reject(new Error("could not parse state from login"));
        return;
      }

      if (stateParams.logout || stateParams.close) {
        d.resolve();
        return;
      }

      if (!params.access_token) {
        d.reject(new Error("didn't get token")); // destroy();
        return;
      }

      if (!stateParams) {
        d.reject(new Error("didn't get matching state")); // could be an attack?
        return;
      }

      // TODO rid token on reject
      testLoginAccounts(getLoginFromTokenParams(null, params))
        .then(save).then(d.resolve, d.reject).then(function (session) {
          return session;
        });
    };

    function getLoginFromTokenParams(ldsaccount, params) {
      if (!params || !(params.access_token || params.accessToken || params.token)) {
        return null;
      }

      return {
        token: params.access_token || params.accessToken || params.token
      , expiresAt: params.expires_at || params.expiresAt
          || Date.now() + (1 * 60 * 60 * 1000) // TODO
      , appScopedId: params.app_scoped_id || params.appScopedId
          || null
      , loginId: params.loginId || params.login_id
      , accountId: params.accountId || params.account_id
      , comment: ldsaccount && (ldsaccount + ' (via lds.org)') // TODO "AJ on Facebook"
      , loginType: ldsaccount && 'ldsaccount'
      };
    }

    function getId(o, p) {
      // object
      if (!o) {
        return null;
      }
      // prefix
      if (!p) {
        return o.appScopedId || o.app_scoped_id || o.id || null;
      } else {
        return o[p + 'AppScopedId'] || o[p + '_app_scoped_id'] || o[p + 'Id'] || o[p + '_id'] || null;
      }
    }

    function getToken(session, accountId) {
      var logins = [];
      var login;
      accountId = getId(accountId) || accountId;

      // search logins first because we know we're actually
      // logged in with said login, y'know?
      session.logins.forEach(function (login) {
        login.accounts.forEach(function (account) {
          if (getId(account) === accountId) {
            logins.push(login);
          }
        });
      });

      login = logins.sort(function (a, b) {
        // b - a // most recent first
        return (new Date(b.expiresAt).value || 0) - (new Date(a.expiresAt).value || 0);
      })[0];

      return login && login.token;
    }

    // this should be done at every login
    // even an existing login may gain new accounts
    function addAccountsToSession(session, login, accounts) {
      var now = Date.now();

      login.accounts = accounts.map(function (account) {
        account.addedAt = account.addedAt || now;
        return {
          id: getId(account)
        , addedAt: now
        };
      });

      accounts.forEach(function (newAccount) {
        if (!session.accounts.some(function (other, i) {
          if (getId(other) === getId(newAccount)) {
            session.accounts[i] = newAccount;
            return true;
          }
        })) {
          session.accounts.push(newAccount);
        }
      });

      session.accounts.sort(function (a, b) {
        return b.addedAt - a.addedAt;
      });
    }

    function removeItem(array, item) {
      var i = array.indexOf(item);

      if (-1 !== i) {
        array.splice(i, 1);
      }
    }

    // this should be done on login and logout
    // an old login may have lost or gained accounts
    function pruneAccountsFromSession(session) {
      var accounts = session.accounts.slice(0);

      // remember, you can't modify an array while it's in-loop
      // well, you can... but it would be bad!
      accounts.forEach(function (account) {
        if (!session.logins.some(function (login) {
          return login.accounts.some(function (a) {
            return getId(a) === getId(account);
          });
        })) {
          removeItem(session.accounts, account);
        }
      });
    }

    function refreshCurrentAccount(session) {
      // select a default session
      if (1 === session.accounts.length) {
        session.accountId = getId(session.accounts[0]);
        session.id = session.accountId;
        session.appScopedId = session.accountId;
        session.token = session.accountId && getToken(session, session.accountId) || null;
        session.userVerifiedAt = session.accounts[0].userVerifiedAt;
        return;
      }

      if (!session.logins.some(function (account) {
        if (session.accountId === getId(account)) {
          session.accountId = getId(account);
          session.id = session.accountId;
          session.appScopedId = session.accountId;
          session.token = session.accountId && getToken(session, session.accountId) || null;
          session.userVerifiedAt = account.userVerifiedAt;
        }
      })) {
        session.accountId = null;
        session.id = null;
        session.appScopedId = null;
        session.token = null;
        session.userVerifiedAt = null;
      }
    }

    function updateSession(session, login, accounts) {
      login.addedAt = login.addedAt || Date.now();

      // sanity check login
      if (0 === accounts.length) {
        login.selectedAccountId = null;
      }
      else if (1 === accounts.length) {
        login.selectedAccountId = getId(accounts[0]);
      }
      else if (accounts.length >= 1) {
        login.selectedAccountId = null;
      }
      else {
        throw new Error("[SANITY CHECK FAILED] bad account length'");
      }

      addAccountsToSession(session, login, accounts);

      // update login if it exists
      // (or add it if it doesn't)
      if (!session.logins.some(function (other, i) {
        if ((login.loginId && other.loginId === login.loginId) || (other.token === login.token)) {
          session.logins[i] = login;
          return true;
        }
      })) {
        session.logins.push(login);
      }

      pruneAccountsFromSession(session);

      refreshCurrentAccount(session);

      session.logins.sort(function (a, b) {
        return b.addedAt - a.addedAt;
      });
    }

    // TODO track granted scopes locally
    function save(updates) {
      // TODO make sure session.logins[0] is most recent
      updateSession(shared.session, updates.login, updates.accounts);

      // TODO should this be done by the LdsApiStorage?
      // TODO how to have different accounts selected in different tabs?
      localStorage.setItem('io.lds.session', JSON.stringify(shared.session));
      return $q.when(shared.session);
    }

    function sanityCheckAccounts(session) {
      var promise;

      // XXX this is just a bugfix for previously deployed code
      // it probably only affects about 10 users and can be deleted
      // at some point in the future (or left as a sanity check)

      if (session.accounts.every(function (account) {
        if (account.appScopedId) {
          return true;
        }
      })) {
        return $q.when(session);
      }

      promise = $q.when();
      session.logins.forEach(function (login) {
        promise = promise.then(function () {
          return testLoginAccounts(login).then(save);
        });
      });

      return promise.then(function (session) {
        return session;
      }, function () {
        // this is just bad news...
        return LdsApiCache.destroy().then(function () {
          $window.alert("Sorry, but an error occurred which can only be fixed by logging you out"
            + " and refreshing the page.\n\nThis will happen automatically.\n\nIf you get this"
            + " message even after the page refreshes, please contact support@ldsconnectorg."
          );
          $window.location.reload();
          return $q.reject(new Error("A session error occured. You must log out and log back in."));
        });
      });
    }

    function restore() {
      // Being very careful not to trigger a false onLogin or onLogout via $watch
      var storedSession;

      if (shared.session.token) {
        return sanityCheckAccounts(shared.session);
        // return $q.when(shared.session);
      }

      storedSession = JSON.parse(localStorage.getItem('io.lds.session') || null) || createSession();

      if (storedSession.token) {
        shared.session = storedSession;
        return sanityCheckAccounts(shared.session);
        //return $q.when(shared.session);
      } else {
        return $q.reject(new Error("No Session"));
      }
    }

    function destroy() {
      if (!shared.session.token) {
        return $q.when(shared.session);
      }

      shared.session = createSession();
      localStorage.removeItem('io.lds.session');
      return LdsApiCache.destroy().then(function (session) {
        return session;
      });
    }

    function accounts(login) {
      return $http.get(
        LdsApiConfig.providerUri + LdsApiConfig.apiPrefix
          + '/accounts' + '?camel=true'
      , { headers: { 'Authorization': 'Bearer ' + login.token } }
      ).then(function (resp) {
        var accounts = resp.data && (resp.data.accounts || resp.data.result || resp.data.results)
          || resp.data || { error: { message: "Unknown Error when retrieving accounts" } }
          ;

        if (accounts.error) { 
          console.error("[ERROR] couldn't fetch accounts", accounts);
          return $q.reject(new Error("Could not verify login:" + accounts.error.message));
        }

        if (!Array.isArray(accounts)) {
          console.error("[Uknown ERROR] couldn't fetch accounts, no proper error", accounts);
          // TODO destroy();
          return $q.reject(new Error("could not verify login")); // destroy();
        }

        return accounts;
      });
    }

    function testLoginAccounts(login) {
      // TODO cache this also, but with a shorter shelf life?
      return LdsIoSession.accounts(login).then(function (accounts) {
        return { login: login, accounts: accounts };
      }, function (err) {
        console.error("[Error] couldn't get accounts (might not be linked)");
        console.warn(err);
        return { login: login, accounts: [] };
      });
    }

    function logout() {
      var state = Math.random();
      var d = $q.defer();
      var pd = destroy();

      loginPromises[state] = d;
      Oauth3.states[state] = { close: true, logout: true };

      var url = LdsApiConfig.realProviderUri + '/oauth3.html?close=true&state=' + state;
      d.$iframe = $('<iframe src="' + url
        + '" width="1px" height="1px" style="opacity: 0.01;" frameborder="0"></iframe>');
      $('body').append(d.$iframe);

      return d.promise.then(function () {
        // TODO return destroy();
        return pd;
      });
    }

    function framedLogin(providerUri, url, state, background) {
      var err;
      if (!state) {
        err = new Error("no state in framedLogin");
        console.warn(err.stack);
        throw err;
      }
      var progressPromises;

      // TODO scope to providerUri
      if (background) {
        progressPromises = backgroundLoginPromises;
      } else {
        progressPromises = foregroundLoginPromises;
      }

      if (progressPromises[providerUri]) {
        loginPromises[state] = progressPromises[providerUri].loginPromise;
        progressPromises[providerUri].states.push(state);
        return progressPromises[providerUri];
      }

      var d = $q.defer();
      loginPromises[state] = d;

      progressPromises[providerUri] = d.promise.then(function (data) {
        // TODO nix extra states and such
        progressPromises[providerUri] = null;
        return data;
      }, function (err) {
        progressPromises[providerUri] = null;
        return $q.reject(err);
      });

      progressPromises[providerUri].loginPromise = d;
      progressPromises[providerUri].states = [state];
      return progressPromises[providerUri];
    }

    function popupLogin(providerUri, url, state) {
      var promise = framedLogin(providerUri, url, state, false);
      var winref;

      if (promise.states.length >= 2) {
        return promise;
      }

      // This is for client-side (implicit grant) oauth2
      winref = $window.open(url, 'ldsioLogin' + Math.random(), 'height=720,width=620');
      loginPromises[state].winref = winref;

      return promise;
    }

    function backgroundLogin(providerUri, url, state) {
      var promise = framedLogin(providerUri, url, state, true);
      var $iframe = $(
        '<iframe'
      + ' src="' + url + '"'
      + ' width="1px" height="1px" style="opacity: 0.01;"'
      + ' frameborder="0"></iframe>'
      );  

      $('body').append($iframe);

      return promise.then(function (data) {
        $iframe.remove();
        return data;
      }, function (err) {
        $iframe.remove();
        return $q.reject(err);
      });
    }

    function login(opts) {
      opts = opts || {};
      // TODO note that this must be called on a click event
      // otherwise the browser will block the popup
      function forceLogin() {
        var promise;

        // TODO always get implicitGrant (for client)
        // and optionally do authorizationCode (for server session)
        if (opts.authorizationRedirect) {
          promise = logins.authorizationRedirect({ popup: true, scope: opts.scope });
        } else {
          promise = logins.implicitGrant({ popup: true, scope: opts.scope });
        }

        return promise;

        /*
        promise.then(function () {
          return logins.implicitGrant({ background: true, scope: opts.scope });
        });
        */
      }

      // TODO check for scope in session
      return checkSession(opts.scope).then(function (session) {
        if (!session.appScopedId || opts && opts.force) {
          return forceLogin();
        }

        return session;
      }, forceLogin);
    }

    function requireLogin(opts) {
      return restore().then(function (session) {
        return session;
      }, function (/*err*/) {
        
        return LdsApiConfig.invokeLogin(opts);
      });
    }

    function realCreateAccount(login) {
      return $http.post(LdsApiConfig.providerUri + '/api' + '/accounts', {
        account: {}
      , logins: [{
          // TODO make appScopedIds even for root app
          id: login.appScopedId || login.app_scoped_id || login.loginId || login.login_id || login.id 
        , token: login.token || login.accessToken || login.accessToken
        }]
      }, { 
        headers: {
          Authorization: 'Bearer ' + login.token
        }
      }).then(function (resp) {
        return resp.data;
      }, function (err) {
        return $q.reject(err);
      });
    }

    function attachLoginToAccount(session, account, newLogin) {
      var url = LdsApiConfig.providerUri + '/api' + '/accounts/' + account.appScopedId + '/logins';
      var token = getToken(session, account);

      return $http.post(
        url
      , { logins: [{
          id: newLogin.appScopedId || newLogin.app_scoped_id || newLogin.loginId || newLogin.login_id || newLogin.id 
        , token: newLogin.token || newLogin.accessToken || newLogin.access_token
        }] }
      , { headers: { 'Authorization': 'Bearer ' + token } }
      ).then(function (resp) {
        if (!resp.data) {
          return $q.reject(new Error("no response when linking login to account"));
        }
        if (resp.data.error) {
          return $q.reject(resp.data.error);
        }

        // return nothing
      }, function (err) {
        console.error('[Error] failed to attach login to account');
        console.warn(err.message);
        console.warn(err.stack);
        return $q.reject(err);
      });
    }

    function handleOrphanLogins(session) {
      var promise;

      promise = $q.when();

      if (session.logins.some(function (login) {
        return !login.accounts.length;
      })) {
        if (session.accounts.length > 1) {
          throw new Error("[Not Implemented] can't yet attach new social logins when more than one lds account is in the session."
            + " Please logout and sign back in with your LDS.org Account only. Then attach the other login.");
        }
        session.logins.forEach(function (login) {
          if (!login.accounts.length) {
            promise = promise.then(function () {
              return attachLoginToAccount(session, session.accounts[0], login);
            });
          }
        });
      }

      return promise.then(function () {
        return session;
      });
    }

    function requireAccountHelper(session) {
      var promise;
      var ldslogins;
      var err;

      if (session.accounts.length) {
        return $q.when(session);
      }

      if (!session.logins.length) {
        console.error("doesn't have any logins");
        return $q.reject(new Error("[Developer Error] do not call requireAccount when you have not called requireLogin."));
      }

      ldslogins = session.logins.filter(function (login) {
        return 'ldsaccount' === login.loginType;
      });

      if (!ldslogins.length) {
        console.error("no lds accounts");
        err = new Error("Login with your LDS Account at least once before linking other accounts.");
        err.code = "E_NO_LDSACCOUNT";
        return $q.reject(err);
      }

      // at this point we have a valid ldslogin, but still no ldsaccount
      promise = $q.when();

      ldslogins.forEach(function (login) {
        promise = promise.then(function () {
          return realCreateAccount(login).then(function (account) {
            login.accounts.push(account);
            return save({ login: login, accounts: login.accounts });
          });
        });
      });

      return promise.then(function (session) {
        return session;
      });
     
    }
    function requireAccount(session) {
      return requireAccountHelper(session).then(handleOrphanLogins);
    }

    function requireSession(opts) {
      var promise = $q.when(opts);

      // TODO create middleware stack
      return promise.then(requireLogin).then(requireAccount);
        // .then(selectAccount).then(verifyAccount)
    }

    function checkSession() {
      return restore();
    }

    function onLogin(_scope, fn) {
      // This is better than using a promise.notify
      // because the watches will unwatch when the controller is destroyed
      _scope.__stsessionshared__ = shared;
      _scope.$watch('__stsessionshared__.session', function (newValue, oldValue) {
        if (newValue.accountId && oldValue.accountId !== newValue.accountId) {
          fn(shared.session);
        }
      }, true);
    }

    function onLogout(_scope, fn) {
      _scope.__stsessionshared__ = shared;
      _scope.$watch('__stsessionshared__.session', function (newValue, oldValue) {
        if (!newValue.accountId && oldValue.accountId) {
          fn(null);
        }
      }, true);
    }

    logins.authorizationRedirect = function (opts) {
      return Oauth3.authorizationRedirect(
        opts.providerUri
      , opts.scope // default to directive from this provider
      , opts.apiHost || LdsApiConfig.providerUri
      , opts.redirectUri
      ).then(function (prequest) {
        if (!prequest.state) {
          throw new Error("[Devolper Error] [authorization redirect] prequest.state is empty");
        }

        if (opts.background) {
          // TODO foreground iframe
          return backgroundLogin(LdsApiConfig.providerUri, prequest.url, prequest.state);
        } else if (opts.popup) {
          // TODO same for new window
          return popupLogin(LdsApiConfig.providerUri, prequest.url, prequest.state);
        } else {
          throw new Error("login framing method not specified");
        }
      });
    };
    logins.implicitGrant = function (opts) {
      opts = opts || {};
      // TODO OAuth3 provider should use the redirect URI as the appId?
      return Oauth3.implicitGrant(
        LdsApiConfig.providerUri
        // TODO OAuth3 provider should referer / origin as the appId?
      , opts.scope
      , opts.redirectUri
      , LdsApiConfig.appId || LdsApiConfig.appUri // (this location)
      ).then(function (prequest) {
        if (!prequest.state) {
          throw new Error("[Devolper Error] [implicit grant] prequest.state is empty");
        }
        if (opts.background) {
          // TODO foreground iframe
          return backgroundLogin(LdsApiConfig.providerUri, prequest.url, prequest.state);
        } else if (opts.popup) {
          // TODO same for new window
          return popupLogin(LdsApiConfig.providerUri, prequest.url, prequest.state);
        }
      });
    };
    logins.resourceOwnerPassword = function (ldsaccount, passphrase, scope) {
      return Oauth3.resourceOwnerPassword(
        LdsApiConfig.providerUri
      , ldsaccount
      , passphrase
      , scope
      , LdsApiConfig.appId || LdsApiConfig.appUri // (this location)
      ).then(function (request) {
        return $http({
          url: request.url + '?camel=true'
        , method: request.method
        , data: request.data
        }).then(function (result) {
          var login = getLoginFromTokenParams(ldsaccount, result.data);

          if (login) {
            return testLoginAccounts(login).then(save);
          }

          if (result.data.error) {
            return $q.reject(result.data.error); 
          }

          if ('string' === typeof result.data){
            return $q.reject(new Error("[Uknown Error] Message: " + result.data)); 
          } 

          console.error("[ERROR] could not retrieve resource owner password token");
          console.warn(result.data);
          return $q.reject(new Error("[Uknown Error] see developer console for details")); 
        });
      });
    };

    function cloneAccount(session, account) {
      // retrieve the most fresh token of all associated logins
      var token = getToken(session, account);
      var id = getId(account);
      // We don't want to modify the original object and end up
      // with potentially whole stakes in the local storage session key
      account = JSON.parse(JSON.stringify(account));

      account.token = token;
      account.accountId = account.accountId || account.appScopedId || id;
      account.appScopedId = account.appScopedId || id;

      return account;
    }

    // TODO check for account and account create if not exists in requireSession
    function selectAccount(session, accountId) {
      // needs to return the account with a valid login
      var account;
      if (!accountId) {
        accountId = session.accountId;
      }

      session.accounts.some(function (a) {
        if (!accountId || accountId === getId(a)) {
          account = a;
          return true;
        }
      });

      account = cloneAccount(session, account);
      session.accountId = account.accountId;
      session.id = account.accountId;
      session.appScopedId = account.accountId;
      session.token = account.token;

      return account;
    }

    LdsIoSession = {
      usernameMinLength: 4
    , secretMinLength: 8
    , accounts: accounts
    , validateUsername: function (ldsaccount) {
        if ('string' !== typeof ldsaccount) {
          throw new Error("[Developer Error] ldsaccount should be a string");
        }

        if (!/^[0-9a-z\.\-_]+$/i.test(ldsaccount)) {
          // TODO validate this is true on the server
          return new Error("Only alphanumeric characters, '-', '_', and '.' are allowed in usernames.");
        }

        if (ldsaccount.length < LdsIoSession.usernameMinLength) {
          // TODO validate this is true on the server
          return new Error('Username too short. Use at least '
            + LdsIoSession.usernameMinLength + ' characters.');
        }

        return true;
      }
    , checkUsername: function (ldsaccount) {
        // TODO support ldsaccount as type
        var type = null;

        // TODO update backend to /api/ldsio/username/:ldsaccount?
        return $http.get(
          LdsApiConfig.providerUri + '/api'
            + '/logins/check/' + type + '/' + ldsaccount + '?camel=true'
        ).then(function (result) {
          if (!result.data.exists) {
            return $q.reject(new Error("username does not exist"));
          }
        }, function (err) {
          if (/does not exist/.test(err.message)) {
            return $q.reject(err);
          }

          throw err;
        });
      }
    , restore: restore
    , destroy: destroy
    , login: login
    , logins: logins
    , logout: logout
    , onLogin: onLogin
    , onLogout: onLogout
    , account: function (session) {
        return session.accounts.filter(function (account) {
          return getId(account) && session.accountId === getId(account);
        })[0] || null;
      }
    , checkSession: checkSession
    , requireSession: requireSession
    , requireAccount: requireAccount
    , selectAccount: selectAccount
    , openAuthorizationDialog: function () {
        // this is intended for the resourceOwnerPassword strategy
        return LdsApiConfig.invokeLogin();
      }
    , implicitGrantLogin: function (opts) {
        var promise;
        opts = opts || {};

        if (!opts.force) {
          promise = $q.when();
        } else {
          promise = $q.reject();
        }

        return promise.then(function () {
          return restore().then(function (session) {
            var promise = $q.when();

            // TODO check expirey
            session.logins.forEach(function (login) {
              promise = promise.then(function () {
                return testLoginAccounts(login).then(save);
              });
            });
            return promise;
          });
        }, function () {
          return logins.implicitGrant({
            background: opts.background // iframe in background
          , popup: opts.popup           // presented in popup
          , window: opts.window         // presented in new tab / new window
          , iframe: opts.iframe         // presented in same window with security code
                                        // linked to bower_components/oauth3/oauth3.html
          , redirectUri: LdsApiConfig.appUri + '/oauth3.html'
          });
        });
      }
    , backgroundLogin: function (opts) {
        opts = opts || {};

        opts.background = true;
        return LdsIoSession.implicitGrantLogin(opts);
      }
    , getToken: getToken
    , getId: getId
    , cloneAccount: cloneAccount
    , debug: {
        refreshCurrentAccount: refreshCurrentAccount
      , updateSession: updateSession
      , testLoginAccounts: testLoginAccounts
      , save: save
      , shared: shared
      }
    };

    window.LdsIo = window.LdsIo || {};
    window.LdsIo.session = LdsIoSession;

    return LdsIoSession;
  }])
  ;
