// /js/nav-auth.js
import { auth } from '/js/auth.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

function gateLinks(user) {
  const links = document.querySelectorAll('a[data-gated]');
  links.forEach(a => {
    const dest = a.getAttribute('data-href') || a.getAttribute('href') || '/';
    if (user) {
      // Logged in → restore real destination
      a.classList.remove('link--gated');
      a.removeAttribute('title');            // keep it clean
      a.setAttribute('href', dest);
      // DO NOT set aria-disabled (avoids pointer-events: none patterns)
      a.removeAttribute('aria-disabled');
    } else {
      // Logged out → keep link clickable, but send to login with ?next=
      a.classList.add('link--gated');
      a.setAttribute('title', 'Login to access');
      const next = encodeURIComponent(dest);
      a.setAttribute('href', `/login.html?next=${next}`);
      // DO NOT use aria-disabled to avoid frameworks disabling clicks
      a.removeAttribute('aria-disabled');
    }
  });
}

onAuthStateChanged(auth, user => gateLinks(user));
