import { useState } from "react";
import { Layout } from "../components.tsx";
import { BookStack } from "../icons.tsx";
import { Link } from "../lib/router.tsx";
import { useSession } from "../lib/session.tsx";
import { isFinishingSignIn, SignInFlow, type SignInStep, signInTitle } from "./SignIn.tsx";

const KINDS = [
  "Daycares",
  "Kindergartens",
  "Schools",
  "Playgroups",
  "Toy libraries",
  "Community shelves",
];

/** The site's front page: what this is, who it's for, and a way in. */
export function FrontPage() {
  const { state } = useSession();
  const me = state.status === "ready" ? state.me : null;
  const signedIn = Boolean(me?.user) && !isFinishingSignIn();
  const [step, setStep] = useState<SignInStep>("email");
  const contact = me?.contactEmail;

  return (
    <Layout title="Borrow a book. Scan. Read together." siteWide>
      <div className={`hero${signedIn ? "" : " hero--signin"}`}>
        <BookStack className="hero__art" />
        <p className="hero__lead">
          Reading Joey is a free home for little lending libraries. Scan the sticker inside a book's
          cover to borrow it, and scan again to bring it back.
        </p>
        {signedIn ? (
          <div className="row hero__actions">
            <Link href="/" absolute className="btn btn--primary hero__cta">
              Open my library
            </Link>
            <a href="#for-libraries" className="hero__link">
              Run a library?
            </a>
          </div>
        ) : (
          <section className="card signin-card" aria-labelledby="signin-heading">
            <h2 id="signin-heading" className="section-title">
              {signInTitle(step)}
            </h2>
            <SignInFlow onStep={setStep} />
          </section>
        )}
      </div>

      <ul className="chips" aria-label="Who it's for">
        {KINDS.map((kind) => (
          <li key={kind} className="chip">
            {kind}
          </li>
        ))}
      </ul>

      <ul className="features">
        <li className="feature">
          <h3 className="feature__title">Scan to borrow</h3>
          <p className="feature__text">
            Point your phone camera at the sticker inside the cover. That's it.
          </p>
        </li>
        <li className="feature">
          <h3 className="feature__title">Gentle reminders</h3>
          <p className="feature__text">
            A friendly email when a book is due back, so nothing gets forgotten.
          </p>
        </li>
        <li className="feature">
          <h3 className="feature__title">Private by design</h3>
          <p className="feature__text">
            Free, no ads, and nothing stored about children: no names, ages or photos.
          </p>
        </li>
      </ul>

      <h2>For families</h2>
      <ol className="steps steps--left">
        <li>Your library gives you its sign-up link or QR poster.</li>
        <li>Sign in with a code sent to your email. No password to remember.</li>
        <li>Scan a book's sticker to borrow it, and again to bring it back.</li>
      </ol>

      <section id="for-libraries" className="cta-band" aria-labelledby="libraries-heading">
        <h2 id="libraries-heading">Run a library? Get yours</h2>
        <p>
          Reading Joey is free for daycares, kindergartens, schools, playgroups, toy libraries and
          community shelves. Volunteers and staff always know where every book is, and families get
          reminders without anyone chasing them.
        </p>
        <p>
          {contact ? (
            <a
              className="btn btn--primary"
              href={`mailto:${contact}?subject=A%20library%20for%20us`}
            >
              Ask for a library
            </a>
          ) : (
            "Libraries are set up by invitation: ask the person who runs this site."
          )}
        </p>
      </section>

      <PublicFooter />
    </Layout>
  );
}

function PublicFooter() {
  return (
    <footer className="public-footer">
      <span className="public-footer__name">Reading Joey</span>
      <Link href="/about">About</Link>
      <Link href="/privacy">Privacy</Link>
      <Link href="/terms">Terms</Link>
    </footer>
  );
}

const DRAFT_NOTE =
  "Plain-English draft: it will be reviewed before more libraries join, and you'll be told of any change.";

export function PrivacyPage() {
  return (
    <Layout title="Privacy policy" siteWide>
      <p className="muted">{DRAFT_NOTE}</p>
      <p className="lead">
        We keep only what a library needs to lend books: who you are, which household you borrow
        for, and what's borrowed. We never sell it or use it for advertising.
      </p>

      <h2>What we store</h2>
      <ul>
        <li>
          Your email address and first name, and the household (family) name you or your library
          gave.
        </li>
        <li>
          If your library has a kiosk tablet: your kiosk code, stored scrambled so nobody can read
          it back, and the first names of any adults the library added without an email address.
        </li>
        <li>Which books your household borrowed, when, and when they were due.</li>
        <li>
          Sign-in records and passkeys (Face ID or fingerprint sign-in), so you can sign in safely.
        </li>
        <li>Nothing about children: no names, ages or photos.</li>
      </ul>

      <h2>Who can see it</h2>
      <ul>
        <li>The staff or volunteers who run your library, to manage the lending.</li>
        <li>
          The person who runs this site, only to help when something goes wrong. Each day they open
          a library is logged, and that library's admins can see it.
        </li>
        <li>
          Services that run the site: Cloudflare (hosting and database) and Resend or Mailjet
          (sending emails). Book details are looked up by barcode only; no personal details are sent
          for that.
        </li>
      </ul>

      <h2>How long we keep it</h2>
      <ul>
        <li>
          Who borrowed a book is forgotten after the period your library sets (12 months unless it
          chose otherwise). The library keeps only counts.
        </li>
        <li>
          Delete your account at any time from your Account page. Your email and sign-in go straight
          away; if you were the last adult in your household, the household goes too.
        </li>
        <li>
          Backups of the database are kept for up to 30 days, so something lost by mistake can be
          restored. Deleted details disappear from backups when those backups expire.
        </li>
      </ul>

      <h2>Questions or changes</h2>
      <p>
        Ask the people who run your library. They can correct your details, or pass your question on
        to the person who runs this site.
      </p>
      <PublicFooter />
    </Layout>
  );
}

export function TermsPage() {
  return (
    <Layout title="Terms of use" siteWide>
      <p className="muted">{DRAFT_NOTE}</p>
      <p className="lead">
        Reading Joey lets little libraries, such as daycares, schools and community shelves, lend
        books to the families who use them. Using it means agreeing to these terms.
      </p>

      <h2>For borrowers</h2>
      <ul>
        <li>Borrow books for your household, and bring them back by the due date.</li>
        <li>
          Tell your library if a book is lost or damaged. Each library decides what happens then;
          this site doesn't charge anything.
        </li>
        <li>Keep your sign-in to yourself: codes and passkeys are just for you.</li>
      </ul>

      <h2>For libraries</h2>
      <ul>
        <li>
          Your admin accepts these terms and the privacy policy for your library, and makes sure
          borrowers know their details are kept here.
        </li>
        <li>Invite only people who use your library, and keep their details accurate.</li>
        <li>
          The site is provided as is, free for now. If a fee is ever needed, libraries will be told
          well in advance and can leave and have their data deleted.
        </li>
        <li>
          The person who runs the site may pause a library that's misused, and may open it to help
          with problems (each visit is logged for your admins).
        </li>
      </ul>
      <PublicFooter />
    </Layout>
  );
}
