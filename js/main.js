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

    menu?.querySelectorAll("a").forEach((a) => {

      a.addEventListener("click", closeMenu);

    });

  }



  /* ── Mobile search ── */

  const searchModal = document.getElementById("search-modal");

  document.getElementById("search-open")?.addEventListener("click", () => searchModal?.removeAttribute("hidden"));

  document.getElementById("search-close")?.addEventListener("click", () => searchModal?.setAttribute("hidden", ""));



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



  /* ── Branches ── */

  function renderBranches() {

    const grid = document.getElementById("locations-grid");

    if (!grid) return;

    const lang = getMainLang();



    grid.innerHTML = (cfg.branches || [])

      .map(

        (b) => `

      <div class="location-item">

        <h3>${lang === "ar" ? b.nameAr : b.nameEn}</h3>

        <p>${lang === "ar" ? b.cityAr : b.cityEn}</p>

      </div>`

      )

      .join("");

  }



  /* ── Newsletter ── */

  const newsletterForm = document.getElementById("newsletter-form");

  const newsletterMsg = document.getElementById("newsletter-msg");



  newsletterForm?.addEventListener("submit", (e) => {

    e.preventDefault();

    if (newsletterMsg) {

      newsletterMsg.hidden = false;

      newsletterMsg.textContent = t("newsletter.success");

    }

    newsletterForm.reset();

  });



  function renderDynamicContent() {

    renderMenu();

    renderBranches();

    wireLinks();

    applyMainI18n(getMainLang());

  }



  document.addEventListener("las-main:languagechange", renderDynamicContent);



  renderDynamicContent();

})();

