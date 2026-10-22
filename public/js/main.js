/* Intelligentsia Scholarship Fund — main.js
   Nav toggle · header shadow · active link · FAQ accordion · scroll reveal */
(() => {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Mobile nav ---------- */
  const header = document.querySelector('[data-header]');
  const toggle = document.querySelector('[data-nav-toggle]');
  const nav = document.getElementById('site-nav');

  const setNav = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    nav.classList.toggle('is-open', open);
    const label = open ? 'Tutup menu' : 'Buka menu';
    toggle.setAttribute('aria-label', label);
    toggle.querySelector('.sr-only').textContent = label;
  };

  if (toggle && nav) {
    toggle.addEventListener('click', () => {
      setNav(toggle.getAttribute('aria-expanded') !== 'true');
    });
    nav.addEventListener('click', (e) => {
      if (e.target.closest('a')) setNav(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && nav.classList.contains('is-open')) {
        setNav(false);
        toggle.focus();
      }
    });
  }

  /* ---------- Header state on scroll ---------- */
  if (header) {
    const onScroll = () => header.classList.toggle('is-scrolled', window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ---------- Active nav link ---------- */
  const navLinks = [...document.querySelectorAll('.site-nav__list a[href^="#"]')];
  const sections = navLinks
    .map((a) => document.querySelector(a.getAttribute('href')))
    .filter(Boolean);

  if ('IntersectionObserver' in window && sections.length) {
    const spy = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const id = `#${entry.target.id}`;
          navLinks.forEach((a) => a.classList.toggle('is-active', a.getAttribute('href') === id));
        });
      },
      { rootMargin: '-40% 0px -55% 0px' }
    );
    sections.forEach((s) => spy.observe(s));
  }

  /* ---------- FAQ accordion ---------- */
  const accordion = document.querySelector('[data-accordion]');
  if (accordion) {
    const triggers = [...accordion.querySelectorAll('.accordion__trigger')];

    const setItem = (btn, open) => {
      btn.setAttribute('aria-expanded', String(open));
      const panel = document.getElementById(btn.getAttribute('aria-controls'));
      if (panel) panel.hidden = !open;
    };

    accordion.addEventListener('click', (e) => {
      const btn = e.target.closest('.accordion__trigger');
      if (!btn) return;
      const willOpen = btn.getAttribute('aria-expanded') !== 'true';
      triggers.forEach((t) => setItem(t, false));
      setItem(btn, willOpen);
    });

    // Arrow-key navigation between questions
    accordion.addEventListener('keydown', (e) => {
      const btn = e.target.closest('.accordion__trigger');
      if (!btn) return;
      const i = triggers.indexOf(btn);
      let next = null;
      if (e.key === 'ArrowDown') next = triggers[(i + 1) % triggers.length];
      if (e.key === 'ArrowUp') next = triggers[(i - 1 + triggers.length) % triggers.length];
      if (e.key === 'Home') next = triggers[0];
      if (e.key === 'End') next = triggers[triggers.length - 1];
      if (next) { e.preventDefault(); next.focus(); }
    });
  }

  /* ---------- Scroll reveal ---------- */
  const revealEls = document.querySelectorAll('[data-reveal]');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealEls.forEach((el) => el.classList.add('is-visible'));
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.1 }
    );
    revealEls.forEach((el) => io.observe(el));
  }
})();
