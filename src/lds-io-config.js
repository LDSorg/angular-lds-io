'use strict';

angular
  .module('lds.io.config', ['lds.io.storage'])
  .service('LdsApiConfig', [
    '$window'
  , 'LdsApiStorage'
  , function LdsApiConfig($window, LdsApiStorage) {
    var defaults = {
      // TODO this should be grabbed from oauth3.html?directives=true&callback=directives
      providerUri: 'https://ldsconnect.org'
    , apiBaseUri: 'https://lds.io'
    , appId: null
    , appUri: $window.location.protocol + '//' + $window.location.host + $window.location.pathname
    , apiPrefix: '/api/ldsio'
    , refreshWait: 15 * 60 * 60 * 1000
    , uselessWait: Infinity
    // note: host includes 'port' when port is non-80 / non-443
    , invokeLogin: function () {
        $window.alert("override `LdsApiConfig.invokeLogin` with a function that shows a login dialog,"
          + " calls LdsApiSession.login on click, and returns a promise in that chain."
          + " TODO document on website");
      }
    };
    var LdsIoConfig = {
      init: function (opts) {
        var me = this;

        opts = opts || {};

        // TODO get multiple keys at once
        return LdsApiStorage.get('dev.providerUri').then(function (val) {
          me.developerMode = true;
          me.providerUri = val;
          me.providerUriSet = true;

          return LdsApiStorage.get('dev.apiBaseUri').then(function (val2) {
            me.apiBaseUri = val2;
            me.apiBaseUriSet = true;
          }, function () {
            // ignore
          });
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
            if ('undefined' === typeof me[key]) {
              me[key] = defaults[key];
            }
          });

          if (!me.appId) {
            // TODO auto-register oauth3
            console.error("Please set `LdsApiConfig.appId`, try this:");
            console.log("    TEST_ID_9e78b54c44a8746a5727c972");
            $window.alert("[ERROR] `LdsApiConfig.appId` not set.\nTest with 'TEST_ID_9e78b54c44a8746a5727c972'");
          }

          console.log('');
          if (!me.providerUriSet) {
            console.info("Why, hello there Latter-Day Developer! Would you like to test against the beta server?");
            console.log("    LdsIo.storage.set('dev.providerUri', 'https://beta.ldsconnect.org')");
            console.log("    LdsIo.storage.set('dev.apiBaseUri', 'https://beta.lds.io')");
            console.log('');
          }
          if (me.providerUriSet || me.apiBaseUriSet) {
            console.info("You're in Developer Mode! :-)");
            console.log("    UI:  " + me.providerUri);
            console.log("    API: " + me.apiBaseUri);
            console.log('');

            console.log("Want to switch back to production mode?");
            console.log("    LdsIo.storage.remove('dev.providerUri'); LdsIo.storage.remove('dev.apiBaseUri');");
            console.log('');
          }

          return me;
        });
      }
    };

    // for easier debugging :)
    $window.LdsIo = $window.LdsIo || {};
    $window.LdsIo.config = LdsIoConfig;

    return LdsIoConfig;
  }])
  ;
