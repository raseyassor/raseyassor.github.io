document.addEventListener('DOMContentLoaded', function () {

  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ─── Dark par défaut — seul 'light' explicite est respecté ─── */
  try {
    if (localStorage.getItem('sera-theme') !== 'light') {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  } catch (e) { document.documentElement.setAttribute('data-theme', 'dark'); }

  /* ─── Theme toggle ─────────────────── */
  document.querySelectorAll('.theme-toggle').forEach(function (toggle) {
    toggle.addEventListener('click', function () {
      var h = document.documentElement;
      var t = h.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      h.setAttribute('data-theme', t);
      localStorage.setItem('sera-theme', t);
    });
  });

  /* ─── Mobile nav drawer ────────────── */
  var navToggle = document.querySelector('.nav-toggle');
  var navOverlay = document.querySelector('.nav-overlay');
  var navEl = document.querySelector('nav');

  function closeNav() {
    navEl && navEl.classList.remove('nav-open');
  }

  if (navToggle && navEl) {
    navToggle.addEventListener('click', function () {
      navEl.classList.toggle('nav-open');
    });
    if (navOverlay) {
      navOverlay.addEventListener('click', closeNav);
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeNav();
    });
  }

  /* ─── Scroll-triggered reveal ──────── */
  if (!reducedMotion && 'IntersectionObserver' in window) {
    var revealObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('revealed');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

    document.querySelectorAll('.reveal').forEach(function (el) {
      revealObserver.observe(el);
    });
  }

  /* ─── KPI number counter ───────────── */
  if (!reducedMotion && 'IntersectionObserver' in window) {
    var counterObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          var el = entry.target;
          var target = parseFloat(el.getAttribute('data-target'));
          if (isNaN(target)) { counterObserver.unobserve(el); return; }
          var duration = parseInt(el.getAttribute('data-duration')) || 1200;
          var start = performance.now();
          var decimals = (target % 1 === 0) ? 0 : String(target).split('.')[1].length;

          function animate(now) {
            var progress = Math.min((now - start) / duration, 1);
            var eased = 1 - Math.pow(1 - progress, 3);
            var current = eased * target;
            el.textContent = current.toFixed(decimals);
            if (progress < 1) {
              requestAnimationFrame(animate);
            } else {
              el.textContent = target.toFixed(decimals);
            }
          }
          requestAnimationFrame(animate);
          counterObserver.unobserve(el);
        }
      });
    }, { threshold: 0.3 });

    document.querySelectorAll('.count-up').forEach(function (el) {
      counterObserver.observe(el);
    });
  }

});
