/**
 * Promise-cached loader for optional browser features.
 *
 * Keep this bootstrap eager and tiny: index.html inline handlers and background
 * event routes can call the stable CodemanApp methods before the optional file
 * has arrived. The loaded module replaces these facades on the prototype.
 */
(function (global) {
  'use strict';

  const features = {
    ralphWizard: { src: 'ralph-wizard.js', promise: null },
  };
  const facades = {};

  function load(name) {
    const feature = features[name];
    if (!feature) return Promise.reject(new Error(`Unknown optional feature: ${name}`));
    if (feature.promise) return feature.promise;

    feature.promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.async = true;
      script.src = feature.src;
      script.dataset.codemanFeature = name;
      script.onload = () => resolve();
      script.onerror = () => {
        script.remove?.();
        reject(new Error(`Could not load optional feature asset ${feature.src}`));
      };
      document.head.appendChild(script);
    }).catch((error) => {
      feature.promise = null;
      throw error;
    });

    return feature.promise;
  }

  async function invoke(name, target, method, args) {
    try {
      await load(name);
      const action = target[method];
      if (typeof action !== 'function' || action === facades[method]) {
        features[name].promise = null;
        throw new Error(`Optional feature ${name} did not install ${method}`);
      }
      return await action.apply(target, args);
    } catch (error) {
      console.error(`[lazy-feature] ${features[name]?.src || name}:`, error);
      target.showToast?.('Could not load Ralph wizard. Check your connection and try again.', 'error');
      return false;
    }
  }

  for (const method of ['showRalphWizard', 'handlePlanSubagentEvent', 'cancelPlanGeneration']) {
    facades[method] = function (...args) {
      return invoke('ralphWizard', this, method, args);
    };
  }

  Object.assign(CodemanApp.prototype, facades);
  global.CodemanLazyFeatures = Object.freeze({ load, invoke });
})(window);
