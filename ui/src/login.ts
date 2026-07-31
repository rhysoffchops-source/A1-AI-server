/* A1 Dashboard Login — Facebook-style gate. The passphrase comes from the username field. */
const form = document.getElementById("login-form") as HTMLFormElement | null;
if (!form) throw new Error("Login form not found.");

const submitBtn = document.getElementById("login-submit") as HTMLButtonElement | null;
const errorEl = document.getElementById("login-error") as HTMLParagraphElement | null;

form.addEventListener("submit", async (event: SubmitEvent) => {
  event.preventDefault();
  const formData = new FormData(form);
  const passphrase = (formData.get("email") as string | null) ?? "";
  if (passphrase.trim() === "") return;

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Logging in…";
  }
  if (errorEl) errorEl.classList.remove("visible");

  try {
    const response = await fetch("/api/v1/access/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passphrase })
    });

    if (!response.ok) {
      if (errorEl) errorEl.classList.add("visible");
      return;
    }

    window.location.href = "/app.html";
  } catch {
    if (errorEl) errorEl.classList.add("visible");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Log In";
    }
  }
});
