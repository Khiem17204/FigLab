import { AlertIcon, Button, Field, InfoIcon, Input, Mascot, type MascotMood } from "@figlab/ui";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";

import { Brand } from "../shell/brand";

export interface SignedInAccount {
  email: string;
  signOut: () => Promise<void>;
}

const MIN_PASSWORD_LENGTH = 6;

/** Shows sign-in until Supabase reports a session, then renders the app for that account. */
export function AuthGate({
  auth,
  children,
}: {
  auth: SupabaseClient;
  children: (account: SignedInAccount) => ReactNode;
}) {
  const [session, setSession] = useState<Session | null>();
  useEffect(() => {
    let active = true;
    void auth.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session);
    });
    const { data } = auth.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [auth]);

  if (session === undefined)
    return (
      <main className="loading-page">
        <Mascot mood="working" size={56} />
        <p role="status">Loading…</p>
      </main>
    );
  if (!session?.user.email) return <SignInScreen auth={auth} />;
  return children({
    email: session.user.email,
    signOut: async () => {
      await auth.auth.signOut();
    },
  });
}

type Mode = "sign-in" | "sign-up" | "verify";
type Notice = { kind: "error" | "info"; text: string; canResend?: boolean };

export function SignInScreen({ auth }: { auth: SupabaseClient }) {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();

  const resend = async () => {
    setBusy(true);
    const { error } = await auth.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    setNotice(
      error
        ? { kind: "error", text: error.message, canResend: true }
        : { kind: "info", text: `Verification email sent again to ${email}.` },
    );
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setNotice(undefined);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setPasswordError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    setBusy(true);
    try {
      if (mode === "sign-up") {
        const { data, error } = await auth.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) setNotice({ kind: "error", text: error.message });
        else if (!data.session) {
          setMode("verify");
          setNotice({
            kind: "info",
            text: `Check ${email} for a verification link, then sign in.`,
            canResend: true,
          });
        }
        return;
      }
      const { error } = await auth.auth.signInWithPassword({ email, password });
      if (error)
        setNotice(
          error.code === "email_not_confirmed"
            ? {
                kind: "error",
                text: "Verify your email before signing in. Check your inbox for the link.",
                canResend: true,
              }
            : { kind: "error", text: error.message },
        );
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setNotice(undefined);
    setPasswordError(undefined);
  };

  const mood: MascotMood =
    mode === "verify" ? "proud" : notice?.kind === "error" ? "oops" : busy ? "working" : "happy";
  const noticeBlock = notice && (
    <div
      className={`auth-notice ${notice.kind}`}
      role={notice.kind === "error" ? "alert" : "status"}
    >
      {notice.kind === "error" ? <AlertIcon size={18} /> : <InfoIcon size={18} />}
      <div>
        <p>{notice.text}</p>
        {notice.canResend && email && (
          <Button className="auth-resend" disabled={busy} onClick={() => void resend()} size="sm">
            Resend verification email
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <main className="auth-page">
      <AuthStory />
      <section aria-labelledby="auth-heading" className="auth-card">
        <Mascot className="auth-mascot" mood={mood} size={64} />
        {mode === "verify" ? (
          <>
            <h1 id="auth-heading">Check your inbox</h1>
            <p className="auth-lede">
              One click on the link in that email confirms your account. It can take a minute to
              arrive, so peek in spam too.
            </p>
            {noticeBlock}
            <Button block onClick={() => switchMode("sign-in")} variant="primary">
              Back to sign in
            </Button>
          </>
        ) : (
          <>
            <h1 id="auth-heading">{mode === "sign-in" ? "Sign in" : "Create an account"}</h1>
            <p className="auth-lede">
              {mode === "sign-in"
                ? "Welcome back. Your figures are where you left them."
                : "Make figures your reviewers can trace. We'll email you a link to confirm."}
            </p>
            <form className="auth-form" noValidate onSubmit={(event) => void submit(event)}>
              <Field label="Email">
                <Input
                  autoComplete="email"
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@lab.org"
                  required
                  type="email"
                  value={email}
                />
              </Field>
              <Field
                error={passwordError}
                hint={
                  mode === "sign-up" && !passwordError
                    ? `At least ${MIN_PASSWORD_LENGTH} characters.`
                    : undefined
                }
                label="Password"
              >
                <Input
                  autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                  minLength={MIN_PASSWORD_LENGTH}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setPasswordError(undefined);
                  }}
                  required
                  type="password"
                  value={password}
                />
              </Field>
              {noticeBlock}
              <Button block loading={busy} size="lg" type="submit" variant="primary">
                {mode === "sign-in" ? "Sign in" : "Sign up"}
              </Button>
            </form>
            <p className="auth-switch">
              {mode === "sign-in" ? "No account yet?" : "Already have an account?"}{" "}
              <button
                className="link-button"
                onClick={() => switchMode(mode === "sign-in" ? "sign-up" : "sign-in")}
                type="button"
              >
                {mode === "sign-in" ? "Create one" : "Sign in"}
              </button>
            </p>
          </>
        )}
      </section>
    </main>
  );
}

function AuthStory() {
  return (
    <aside aria-label="About FigLab" className="auth-story">
      <Brand />
      <p className="auth-story-title">
        Figures you can trace back to <span className="fl-highlight">the pixel</span>.
      </p>
      <ul className="auth-points">
        <li>Upload PNG, JPEG or 16-bit TIFF originals. They are never altered.</li>
        <li>Crop, arrange and adjust panels without touching source data.</li>
        <li>Export a PNG rendered from the original samples, with provenance recorded.</li>
      </ul>
      <figure aria-hidden="true" className="auth-sketch">
        <span className="sketch-panel a" />
        <span className="sketch-panel b" />
        <span className="sketch-panel c" />
        <figcaption className="fl-hand-note">every crop remembers its source ✿</figcaption>
      </figure>
    </aside>
  );
}
