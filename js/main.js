(function () {

  const cfg = window.LAS_MAIN_CONFIG;

  if (!cfg) return;



  /* ── Language buttons ── */

  document.querySelectorAll("[data-set-lang]").forEach((btn) => {

    btn.addEventListener("click", () => {

      setMainLang(btn.dataset.setLang);

      renderDynamicContent();

    });

  });



  /* ── Side menu ── */

  const menu = document.getElementById("side-menu");

  const backdrop = document.getElementById("nav-backdrop");

  const openBtns = [document.getElementById("nav-open"), document.getElementById("nav-open-mobile")];

  const closeBtn = document.getElementById("nav-close");



  function openMenu() {

    menu?.classList.add("open");

    backdrop?.classList.add("open");

    document.body.classList.add("menu-open");

    menu?.setAttribute("aria-hidden", "false");

  }



  function closeMenu() {

    menu?.classList.remove("open");

    backdrop?.classList.remove("open");

    document.body.classList.remove("menu-open");

    menu?.setAttribute("aria-hidden", "true");

  }



  openBtns.forEach((btn) => btn?.addEventListener("click", openMenu));

  closeBtn?.addEventListener("click", closeMenu);

  backdrop?.addEventListener("click", closeMenu);



  function bindMenuLinks() {
    menu?.querySelectorAll("#side-menu-nav a").forEach((a) => {
      a.addEventListener("click", closeMenu);
    });
  }

  document.querySelector(".side-menu-brand")?.addEventListener("click", closeMenu);



  /* ── Coming soon for unfinished pages ── */

  const COMING_SOON_HASHES = new Set(["#store", "#booking", "#catering"]);
  let comingSoonTimer;

  function isComingSoonHref(href) {
    if (!href || href === "#") return true;
    const hash = href.includes("#") ? `#${href.split("#").pop()}` : "";
    return COMING_SOON_HASHES.has(hash);
  }

  function showComingSoon() {
    const toast = document.getElementById("coming-soon-toast");
    if (!toast) return;
    toast.textContent = t("comingSoon");
    toast.classList.add("show");
    clearTimeout(comingSoonTimer);
    comingSoonTimer = setTimeout(() => toast.classList.remove("show"), 1800);
  }

  document.addEventListener("click", (e) => {
    const searchBtn = e.target.closest(".search-trigger");
    const cart = e.target.closest(".cart-link");
    const linked = e.target.closest("[data-link]");
    const hashLink = e.target.closest("a[href]");
    const href = hashLink?.getAttribute("href") || "";
    const hash = href.includes("#") ? `#${href.split("#").pop()}` : "";

    if (hash === "#terms") {
      e.preventDefault();
      closeMenu();
      setTermsOpen(true);
      document.getElementById("terms")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    if (searchBtn) {
      e.preventDefault();
      showComingSoon();
      return;
    }

    if (cart) {
      e.preventDefault();
      showComingSoon();
      closeMenu();
      return;
    }

    if (linked && isComingSoonHref(linked.getAttribute("href"))) {
      e.preventDefault();
      showComingSoon();
      closeMenu();
      return;
    }

    if (hashLink && isComingSoonHref(href)) {
      e.preventDefault();
      showComingSoon();
      closeMenu();
    }
  });

  document.querySelectorAll(".search-wrap input").forEach((input) => {
    input.addEventListener("focus", () => {
      input.blur();
      showComingSoon();
    });
  });



  /* ── Menu from sections config ── */

  function renderMenu() {

    const nav = document.getElementById("side-menu-nav");

    if (!nav) return;



    const sectionLinks = (cfg.sections || [])

      .map((section) => `<a href="#${section.id}" data-i18n="${section.navKey}"></a>`)

      .join("");



    nav.innerHTML = sectionLinks;

    bindMenuLinks();

  }



  /* ── Portal / cart links ── */

  function wireLinks() {

    const map = {

      store: cfg.links.store,

      booking: cfg.links.booking,

      catering: cfg.links.catering,

    };

    Object.entries(map).forEach(([key, url]) => {

      document.querySelectorAll(`[data-link="${key}"]`).forEach((el) => el.setAttribute("href", url));

    });

  }



  /* ── Branches (from lascafe.sa) ── */

  const ICONS = {
    menu: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 4h10a1 1 0 0 1 1 1v15l-6-3-6 3V5a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.5"/><path d="M9 8h6M9 12h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    map: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11z" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="10" r="2.2" stroke="currentColor" stroke-width="1.5"/></svg>',
    phone: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6.5 3.8h3.2l1.2 3-2 1.4a12 12 0 0 0 6.7 6.7l1.4-2 3 1.2v3.2c0 .7-.6 1.3-1.3 1.3C9.6 18.6 5.4 14.4 5.2 5.1c0-.7.6-1.3 1.3-1.3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    whatsapp: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 4.5a7.5 7.5 0 0 0-6.4 11.3L5 20l4.3-.6A7.5 7.5 0 1 0 12 4.5z" stroke="currentColor" stroke-width="1.5"/><path d="M9.2 9.8c.2-.4.4-.4.6-.4h.5c.2 0 .3.1.4.3l.6 1.4c.1.2 0 .4-.1.5l-.4.4c.6 1.1 1.5 2 2.7 2.7l.4-.4c.2-.2.4-.2.5-.1l1.4.6c.2.1.3.2.3.4v.5c0 .2 0 .4-.4.6A5 5 0 0 1 9.2 9.8z" fill="currentColor"/></svg>',
  };

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderBranchCard(branch) {
    const logos = cfg.deliveryLogos || {};
    const actions = [
      branch.menu && { key: "menu", href: branch.menu, icon: ICONS.menu, label: t("branch.menu"), external: true },
      branch.map && { key: "map", href: branch.map, icon: ICONS.map, label: t("branch.map"), external: true },
      branch.phone && { key: "phone", href: `tel:${branch.phone}`, icon: ICONS.phone, label: t("branch.phone") },
      branch.whatsapp && { key: "whatsapp", href: branch.whatsapp, icon: ICONS.whatsapp, label: t("branch.whatsapp"), external: true },
    ].filter(Boolean);

    const actionHtml = actions
      .map((action) => {
        const extra = action.external ? ' target="_blank" rel="noopener"' : "";
        return `<a class="branch-action" href="${escapeHtml(action.href)}"${extra}>${action.icon}<span>${action.label}</span></a>`;
      })
      .join("");

    const deliveryHtml = (branch.delivery || [])
      .map((item) => {
        const logo = logos[item.id];
        if (!logo) return "";
        return `<a class="branch-delivery-link" href="${escapeHtml(item.href)}" target="_blank" rel="noopener">
          <img src="${escapeHtml(logo.src)}" alt="${escapeHtml(logo.alt)}" />
        </a>`;
      })
      .join("");

    return `
      <article class="branch-card">
        <div class="branch-card-photo">
          <img src="${escapeHtml(branch.image)}" alt="${escapeHtml(branch.nameAr)} - ${escapeHtml(branch.nameEn)}" />
          <h3 class="branch-card-title">${escapeHtml(branch.nameAr)} - ${escapeHtml(branch.nameEn)}</h3>
        </div>
        <div class="branch-card-body">
          <div class="branch-actions">${actionHtml}</div>
          ${deliveryHtml ? `<div class="branch-delivery">${deliveryHtml}</div>` : ""}
        </div>
      </article>`;
  }

  function renderBranches() {
    const grid = document.getElementById("locations-grid");
    if (!grid) return;

    const cities = cfg.cities || [];
    const branches = cfg.branches || [];

    const cityHtml = cities
      .map((city) => {
        const cityBranches = branches.filter((branch) => branch.cityId === city.id);
        if (!cityBranches.length) return "";
        return `
          <section class="city-group" aria-label="${escapeHtml(city.nameAr)} | ${escapeHtml(city.nameEn)}">
            <h3 class="city-heading">${escapeHtml(city.nameAr)} | ${escapeHtml(city.nameEn)}</h3>
            <div class="branch-grid">${cityBranches.map(renderBranchCard).join("")}</div>
          </section>`;
      })
      .join("");

    const bonat = cfg.links?.bonat
      ? `<aside class="loyalty-block">
          <h3 class="city-heading" data-i18n="branch.bonatTitle">${t("branch.bonatTitle")}</h3>
          <a class="branch-action branch-action--wide" href="${escapeHtml(cfg.links.bonat)}" target="_blank" rel="noopener">
            <span data-i18n="branch.bonatCta">${t("branch.bonatCta")}</span>
          </a>
        </aside>`
      : "";

    grid.innerHTML = cityHtml + bonat;
  }

  function renderPolicies() {
    const board = document.getElementById("terms-board");
    if (!board) return;
    const lang = getMainLang();

    board.innerHTML = (cfg.policies || [])
      .map((policy) => {
        const title = lang === "en" ? policy.titleEn : policy.titleAr;
        const items = lang === "en" ? policy.itemsEn : policy.itemsAr;
        const list = (items || [])
          .map((item) => `<li>${escapeHtml(item)}</li>`)
          .join("");
        return `
          <article class="policy-block" id="policy-${escapeHtml(policy.id)}">
            <h3 class="policy-title">${escapeHtml(title)}</h3>
            <ul class="policy-list">${list}</ul>
          </article>`;
      })
      .join("");
  }

  function isTermsOpen() {
    return document.getElementById("terms-toggle")?.getAttribute("aria-expanded") === "true";
  }

  function setTermsOpen(open) {
    const toggle = document.getElementById("terms-toggle");
    const panel = document.getElementById("terms-panel");
    if (!toggle || !panel) return;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.classList.toggle("is-open", open);
    panel.hidden = !open;
  }

  document.getElementById("terms-toggle")?.addEventListener("click", () => {
    setTermsOpen(!isTermsOpen());
  });



  /* ── Newsletter ── */

  const newsletterForm = document.getElementById("newsletter-form");

  const newsletterMsg = document.getElementById("newsletter-msg");



  newsletterForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    showComingSoon();
    newsletterForm.reset();
  });



  function renderDynamicContent() {

    renderMenu();

    renderBranches();

    renderPolicies();

    wireLinks();

    applyMainI18n(getMainLang());

  }



  document.addEventListener("las-main:languagechange", renderDynamicContent);



  renderDynamicContent();

})();

