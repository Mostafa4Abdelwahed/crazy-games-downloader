/* Sanitized structural fixture modeled on a real generic Unity WebGL
 * loader bundle: the config values are supplied by the CALLER through
 * createUnityInstance(canvas, config), so this file contains NO literal
 * asset URLs — only property reads (m.dataUrl) and defaults.
 * A static parser must NOT mistake these reads for resolved values. */
function createUnityInstance(t, n, d) {
  function e(n, t, o) {
    return null == n[t] && (n[t] = o), n[t];
  }
  return new Promise(function (r, i) {
    var a = {};
    function s(t, n) {
      return (
        (a[t] = n),
        t.endsWith('.wasm.br') || t.endsWith('.data.br')
          ? { then: function () {} }
          : n
      );
    }
    for (o in (e(n, 'companyName', 'Unity'),
    e(n, 'productName', 'WebGL Player'),
    e(n, 'productVersion', '1.0'),
    n))
      m[o] = n[o];
    var m = {
      dataUrl: s(m.dataUrl, 'data'),
      frameworkUrl: s(m.frameworkUrl, 'framework'),
      codeUrl: s(m.codeUrl, 'code'),
      streamingAssetsUrl: 'StreamingAssets',
      wasmFileSize: 40457890,
      totalMemory: 268435456,
    };
    Promise.all([m.dataUrl, m.frameworkUrl, m.codeUrl]).then(function (o) {
      r({ canvas: t, config: m });
    }, i);
  });
}
