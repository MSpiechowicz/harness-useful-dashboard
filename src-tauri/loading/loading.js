// The shell calls this when the dashboard server did not start: `text` is the server's own message in the user's
// language, or null when there is none (a timeout, a crash). No inline script anywhere, the page's CSP forbids it.
(function () {
  var TITLES = {
    en: "The dashboard could not start",
    de: "Das Dashboard konnte nicht gestartet werden",
    es: "No se pudo iniciar el panel",
    fr: "Le tableau de bord n'a pas pu démarrer",
    pl: "Nie udało się uruchomić dashboardu",
    pt: "Não foi possível iniciar o dashboard",
  };

  window.showStartupError = function (lang, text) {
    var code = typeof lang === "string" && Object.prototype.hasOwnProperty.call(TITLES, lang) ? lang : "en";
    document.documentElement.lang = code;

    document.getElementById("loading").classList.add("failed");
    document.getElementById("error-title").textContent = TITLES[code];

    var detail = document.getElementById("error-text");
    detail.hidden = !text;
    detail.textContent = text || "";

    document.getElementById("error").hidden = false;
  };
})();
