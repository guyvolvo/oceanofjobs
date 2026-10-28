// The sign-in dialog, for every page that has one.
//
// It used to live in hero_account.js, which only the landing and contact
// pages load, so the board grew its own panel hanging under the Log in
// button instead: the same four controls, a different shape, in a
// different place. Two implementations of one screen, and they drifted.
//
// This is that dialog, loaded everywhere, opened by name. auth.js still
// does all the work; this is the window it needs and nothing more. The
// signed-out card on /account (apply/src/account/Account.tsx) has the
// same steps and copy.
(function () {
const EMAIL_TITLE = "Log in to Ocean of Jobs";

function openSignIn() {
  if (document.getElementById("signin-scrim")) return;
  const wrap = document.createElement("div");
  wrap.id = "signin-scrim";
  wrap.className = "signin-scrim";
  wrap.innerHTML = `
    <div class="signin-dialog" role="dialog" aria-modal="true" aria-labelledby="signin-title" aria-describedby="signin-sub">
      <img class="signin-mark" src="/favicon.svg?v=3" width="44" height="44" alt="" />
      <div class="signin-head">
        <h2 id="signin-title">${EMAIL_TITLE}</h2>
        <p id="signin-sub" hidden></p>
      </div>
      <div class="signin-consent" id="signin-consent">
        <label class="signin-check"><input type="checkbox" id="signin-terms"> <span>I agree to the <a href="/terms" target="_blank" rel="noopener">Terms of Service</a> and <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a></span></label>
        <label class="signin-check"><input type="checkbox" id="signin-news"> <span>Email me about new features and product updates</span></label>
      </div>
      <form class="signin-form" id="signin-email-form">
        <label for="signin-email-input">Email</label>
        <input type="email" id="signin-email-input" name="email" placeholder="you@example.com" required autocomplete="email" spellcheck="false" autocapitalize="off" />
        <button class="signin-primary" type="submit">Send code</button>
      </form>
      <form class="signin-form" id="signin-otp-form" hidden>
        <label for="signin-otp-input">Code</label>
        <input type="text" id="signin-otp-input" name="code" placeholder="Code from the email" inputmode="numeric" pattern="[0-9]{4,10}" required autocomplete="one-time-code" spellcheck="false" autocapitalize="off" />
        <button class="signin-primary" type="submit">Log in</button>
      </form>
      <p class="auth-error" id="signin-auth-error" role="alert" hidden></p>
      <div id="signin-other">
        <div class="signin-or">or</div>
        <div class="signin-providers">
          <button class="signin-provider" id="signin-google" type="button" aria-label="Continue with Google">
            <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"/><path fill="#FBBC05" d="M3.964 10.71c-.18-.54-.282-1.117-.282-1.71s.102-1.17.282-1.71V4.958H.957C.348 6.173 0 7.548 0 9s.348 2.827.957 4.042l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/></svg>
            <span>Google</span>
          </button>
          <button class="signin-provider" id="signin-github" type="button" aria-label="Continue with GitHub">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
            <span>GitHub</span>
          </button>
        </div>
        <p class="signin-foot">New here? Logging in creates your account.</p>
      </div>
      <button type="button" class="signin-back" id="signin-back" hidden>
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M13 8H3m4-4L3 8l4 4"/></svg>
        Use a different email
      </button>
      <button type="button" class="signin-close" id="signin-close" aria-label="Close">
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>
      </button>
    </div>`;
  document.body.appendChild(wrap);

  const $ = (id) => document.getElementById(id);
  const err = $("signin-auth-error");
  const emailForm = $("signin-email-form"), otpForm = $("signin-otp-form");
  // The message sits under the field it is about, above that form's button.
  const showError = (msg) => {
    const form = otpForm.hidden ? emailForm : otpForm;
    form.insertBefore(err, form.querySelector("button"));
    err.textContent = msg;
    err.hidden = false;
  };
  setAuthErrorSink(showError);
  const clear = () => { err.hidden = true; };
  // The terms box: asked once per browser and policy version. Its choices
  // wait in localStorage for the first page that loads signed in, which
  // also covers Google and GitHub, whose sign-in leaves this page.
  const consent = $("signin-consent");
  consent.hidden = consentAgreedHere();
  const agreed = () => {
    if (consent.hidden) return true;
    if ($("signin-terms").checked) {
      rememberConsent($("signin-news").checked);
      return true;
    }
    consent.after(err);
    err.textContent = "Agree to the Terms of Service and Privacy Policy to continue.";
    err.hidden = false;
    $("signin-terms").focus();
    return false;
  };
  $("signin-terms").addEventListener("change", () => { if ($("signin-terms").checked) clear(); });
  const step = (code) => {
    clear();
    emailForm.hidden = code;
    otpForm.hidden = !code;
    $("signin-other").hidden = code;
    consent.hidden = code || consentAgreedHere();
    $("signin-back").hidden = !code;
    const sub = $("signin-sub");
    if (code) {
      $("signin-title").textContent = "Check your email";
      const to = document.createElement("strong");
      to.textContent = $("signin-email-input").value.trim();
      sub.replaceChildren("We sent a code to ", to, ".");
      sub.hidden = false;
      $("signin-otp-input").value = "";
      $("signin-otp-input").focus();
    } else {
      $("signin-title").textContent = EMAIL_TITLE;
      sub.hidden = true;
      $("signin-email-input").focus();
    }
  };
  const close = () => { wrap.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  $("signin-close").addEventListener("click", close);
  $("signin-back").addEventListener("click", () => step(false));
  $("signin-google").addEventListener("click", () => { clear(); if (agreed()) startGoogleSignIn(); });
  $("signin-github").addEventListener("click", () => { clear(); if (agreed()) startGithubSignIn(); });
  emailForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clear();
    if (!agreed()) return;
    const btn = emailForm.querySelector("button");
    btn.disabled = true;
    try {
      await startEmailSignIn($("signin-email-input").value.trim());
      step(true);
    } catch (e2) {
      showError(SEND_CODE_FAILED);
    } finally {
      btn.disabled = false;
    }
  });
  otpForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    clear();
    const btn = otpForm.querySelector("button");
    btn.disabled = true;
    try {
      await verifyEmailOtp($("signin-otp-input").value.trim());
      close();
      notifyAuthRender();  // the bar becomes My account, on the page they were reading
    } catch (e2) {
      showError(verifyCodeError(e2));
    } finally {
      btn.disabled = false;
    }
  });
  $("signin-email-input").focus();
}

  // Opened from the bar on the landing page, the top bar on the board,
  // and the phone menu on both.
  window.openSignIn = openSignIn;
})();
