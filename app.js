/* AWPL Outward Register - app logic.
 * Settings (API URL, employee list) are in config.js. */
(function () {
  "use strict";

  var CFG = window.AWPL_CONFIG || {};
  var FIELDS = ["date", "officerOffice", "place", "description", "submittedBy", "remarks"];
  var REQUIRED = {
    date: "Select the letter date.",
    officerOffice: "Enter the officer or office name and address.",
    place: "Enter the place.",
    description: "Enter a short description.",
    submittedBy: "Select who is submitting."
  };
  var KEY_USER = "awpl.outward.user";
  var KEY_RECENT = "awpl.outward.recent";
  var MAX_RECENT = 6;
  var TIMEOUT_MS = 30000;

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- safe storage (private browsing can block it) ---------- */
  function store(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }
  function load(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  /* ---------- helpers ---------- */
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
  }

  function todayLocal() {
    var d = new Date();
    var local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  function prettyDate(iso) {
    var p = String(iso || "").split("-");
    if (p.length !== 3) return iso || "";
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    return d.toLocaleDateString("en-IN", {
      day: "numeric", month: "short", year: "numeric", timeZone: "UTC"
    });
  }

  function nowIST() {
    return new Date().toLocaleString("en-IN", {
      day: "numeric", month: "short", year: "numeric",
      hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata"
    });
  }

  var toastTimer;
  function toast(message) {
    var t = $("toast");
    t.textContent = message;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("show"); }, 2200);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy") ? resolve() : reject();
      } catch (e) { reject(e); }
      document.body.removeChild(ta);
    });
  }

  /* ---------- form setup ---------- */
  function fillEmployees() {
    var sel = $("submittedBy");
    (CFG.EMPLOYEES || []).forEach(function (name) {
      var o = document.createElement("option");
      o.value = name;
      o.textContent = name;
      sel.appendChild(o);
    });
    var saved = load(KEY_USER);
    if (saved && (CFG.EMPLOYEES || []).indexOf(saved) !== -1) sel.value = saved;
  }

  function resetForm() {
    ["officerOffice", "place", "description", "remarks"].forEach(function (id) {
      $(id).value = "";
    });
    $("date").value = todayLocal();
    clearAllErrors();
    hideBanner();
  }

  /* ---------- validation ---------- */
  function setError(id, message) {
    var el = $(id), msg = $("err-" + id);
    el.setAttribute("aria-invalid", "true");
    msg.textContent = message;
    msg.hidden = false;
  }
  function clearError(id) {
    var el = $(id), msg = $("err-" + id);
    el.removeAttribute("aria-invalid");
    if (msg) { msg.hidden = true; msg.textContent = ""; }
  }
  function clearAllErrors() { Object.keys(REQUIRED).forEach(clearError); }

  function validate() {
    clearAllErrors();
    var first = null;
    Object.keys(REQUIRED).forEach(function (id) {
      var v = $(id).value.trim();
      if (!v) {
        setError(id, REQUIRED[id]);
        if (!first) first = id;
      }
    });
    if (first) $(first).focus();
    return !first;
  }

  function showBanner(text) { var b = $("banner"); b.textContent = text; b.hidden = false; }
  function hideBanner() { $("banner").hidden = true; }

  /* ---------- request handling ---------- */
  // The same requestId is reused when the SAME entry is retried, so a request
  // that actually reached the server can never issue a second number.
  var pending = null;   // { fingerprint, requestId }
  var lastIssued = null;

  function readValues() {
    var v = {};
    FIELDS.forEach(function (id) { v[id] = $(id).value.trim(); });
    return v;
  }

  function setLoading(on) {
    var b = $("getBtn");
    b.disabled = on;
    b.textContent = on ? "Getting number…" : "Get outward number";
  }

  function onSubmit(ev) {
    ev.preventDefault();
    hideBanner();

    if (!validate()) return;

    if (!CFG.API_URL || CFG.API_URL.indexOf("PASTE_YOUR") !== -1) {
      showBanner("The app is not connected to the register yet. Ask the administrator to set the web app URL in config.js.");
      return;
    }
    if (navigator.onLine === false) {
      showBanner("You are offline. Connect to the internet and try again.");
      return;
    }

    var values = readValues();
    var fingerprint = JSON.stringify(values);
    if (!pending || pending.fingerprint !== fingerprint) {
      pending = { fingerprint: fingerprint, requestId: uuid() };
    }

    var params = new URLSearchParams({
      action: "issue",
      date: values.date,
      officerOffice: values.officerOffice,
      place: values.place,
      description: values.description,
      submittedBy: values.submittedBy,
      remarks: values.remarks,
      requestId: pending.requestId
    });

    setLoading(true);

    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);

    fetch(CFG.API_URL + "?" + params.toString(), {
      method: "GET",
      cache: "no-store",
      signal: ctrl.signal
    })
      .then(function (res) {
        if (!res.ok) throw new Error("http-" + res.status);
        return res.text();
      })
      .then(function (text) {
        var data;
        try { data = JSON.parse(text); }
        catch (e) { throw new Error("bad-reply"); }

        if (!data.ok) {
          // The server answered and refused: show its reason, keep the form.
          pending = null;
          showBanner(data.error || "The register could not issue a number.");
          return;
        }
        pending = null;
        onIssued(values, data);
      })
      .catch(function (err) {
        if (err && err.message === "bad-reply") {
          showBanner("The register sent an unexpected reply. Tell the administrator: the web app may not be set to “Anyone” access, or the URL in config.js is wrong.");
        } else {
          showBanner("Could not reach the register. Check your connection and tap Get outward number again. If your entry already went through, trying again will not issue a second number.");
        }
      })
      .then(function () {
        clearTimeout(timer);
        setLoading(false);
      });
  }

  /* ---------- result ---------- */
  function onIssued(values, data) {
    lastIssued = {
      no: data.outwardNo,
      date: values.date,
      officerOffice: values.officerOffice,
      place: values.place,
      description: values.description,
      at: nowIST()
    };

    store(KEY_USER, values.submittedBy);
    addRecent(lastIssued);

    $("outwardNo").textContent = lastIssued.no;
    $("issuedAt").textContent = data.reused
      ? "Already issued for this entry"
      : "Issued " + lastIssued.at;
    $("summary").textContent =
      "Letter dated " + prettyDate(values.date) + ", " + values.place + ". " + values.description;

    // Restart the stamp animation each time.
    var stamp = $("stamp");
    stamp.style.animation = "none";
    void stamp.offsetWidth;
    stamp.style.animation = "";

    $("shareBtn").hidden = !navigator.share;
    $("formView").hidden = true;
    $("resultView").hidden = false;
    window.scrollTo(0, 0);
    $("resultTitle").focus();
  }

  function newEntry() {
    resetForm();
    $("resultView").hidden = true;
    $("formView").hidden = false;
    window.scrollTo(0, 0);
    $("officerOffice").focus();
  }

  function shareText(item) {
    return "Outward No. " + item.no +
      "\nDate: " + prettyDate(item.date) +
      "\nTo: " + item.officerOffice +
      "\nPlace: " + item.place +
      "\nSubject: " + item.description;
  }

  /* ---------- recent list (this phone only) ---------- */
  function getRecent() {
    try { return JSON.parse(load(KEY_RECENT) || "[]"); }
    catch (e) { return []; }
  }

  function addRecent(item) {
    var list = getRecent().filter(function (x) { return x.no !== item.no; });
    list.unshift(item);
    store(KEY_RECENT, JSON.stringify(list.slice(0, MAX_RECENT)));
    renderRecent();
  }

  function renderRecent() {
    var list = getRecent();
    var ul = $("recent");
    ul.textContent = "";
    $("recentWrap").hidden = list.length === 0;

    list.forEach(function (item) {
      var li = document.createElement("li");
      var btn = document.createElement("button");
      btn.type = "button";

      var top = document.createElement("div");
      top.className = "r-top";
      var no = document.createElement("span");
      no.className = "r-no";
      no.textContent = item.no;
      var dt = document.createElement("span");
      dt.className = "r-date";
      dt.textContent = prettyDate(item.date);
      top.appendChild(no);
      top.appendChild(dt);

      var desc = document.createElement("div");
      desc.className = "r-desc";
      desc.textContent = item.place + ": " + item.description;

      btn.appendChild(top);
      btn.appendChild(desc);
      btn.addEventListener("click", function () {
        copyText(item.no).then(
          function () { toast("Copied " + item.no); },
          function () { toast("Could not copy. Select the number manually."); }
        );
      });

      li.appendChild(btn);
      ul.appendChild(li);
    });
  }

  /* ---------- wiring ---------- */
  function init() {
    fillEmployees();
    $("date").value = todayLocal();
    renderRecent();

    FIELDS.forEach(function (id) {
      $(id).addEventListener("input", function () { clearError(id); });
      $(id).addEventListener("change", function () { clearError(id); });
    });

    $("entryForm").addEventListener("submit", onSubmit);
    $("newBtn").addEventListener("click", newEntry);

    $("copyBtn").addEventListener("click", function () {
      if (!lastIssued) return;
      copyText(lastIssued.no).then(
        function () { toast("Copied " + lastIssued.no); },
        function () { toast("Could not copy. Select the number manually."); }
      );
    });

    $("shareBtn").addEventListener("click", function () {
      if (!lastIssued || !navigator.share) return;
      navigator.share({ text: shareText(lastIssued) }).catch(function () {});
    });

    function syncOnline() { $("offline").hidden = navigator.onLine !== false; }
    window.addEventListener("online", syncOnline);
    window.addEventListener("offline", syncOnline);
    syncOnline();

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("./sw.js").catch(function () {});
      });
    }
  }

  init();
})();
