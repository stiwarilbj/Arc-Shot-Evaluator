import { useState, type ReactNode } from "react";
import {
  ArrowRight,
  ShieldCheck,
  Play,
  RotateCcw,
} from "lucide-react";
import "./home.css";

// These small, illustrative diagrams never run the analysis or inference engines.
export function HomePage() {
  return (
    <main className="arc-home">
      <header className="home-intro">
        <div className="home-hero-copy">
          <p className="home-eyebrow home-app-name">
            ARCade Hoops · A basketball toolkit
          </p>
          <h1>
            See your game
            <br />
            from every <span>angle</span>
          </h1>
          <p className="home-hero-description">
            Tools to study your shot, build plays, and explore the game
          </p>
          <div className="home-hero-actions">
            <HomeLink className="home-primary-link" href="#shot-analyzer">
              Review a shot <ArrowRight size={18} aria-hidden="true" />
            </HomeLink>
            <button
              type="button"
              className="home-browse-link"
              onClick={() => {
                const heading = document.getElementById("home-tools-heading");
                heading?.scrollIntoView({ block: "start" });
                heading?.focus({ preventScroll: true });
              }}
            >
              Explore the tools <span aria-hidden="true">↓</span>
            </button>
          </div>
          <p className="home-privacy">
            <ShieldCheck size={15} aria-hidden="true" /> No account · No paid
            inference API · Your uploads stay on your device
          </p>
        </div>
      </header>
      <div className="home-tools-heading">
        <div>
          <h2 id="home-tools-heading" tabIndex={-1}>
            Explore the tools
          </h2>
        </div>
        <p>Try a demo or open a workspace</p>
      </div>
      <div className="home-features">
        <Feature
          number="01"
          title="Shot Analyzer"
          description="Review attempts, mark outcomes, and export shot data"
          detail="Full vision analysis in the downloaded app"
          href="#shot-analyzer"
        >
          <ShotDemo />
        </Feature>
        <Feature
          number="02"
          title="Playbook"
          description="Draw routes, screens, and passes, then watch your idea move"
          detail="24 starter plays · PNG export"
          href="#playbook"
        >
          <PlayDemo />
        </Feature>
        <Feature
          number="03"
          title="Counter Lab"
          description="Compare defenses, inspect breakdowns, and test verified repairs"
          detail="Save improved copies to Playbook"
          href="#counter-lab"
        >
          <CounterDemo />
        </Feature>
        <Feature
          number="04"
          title="Guess the Jumper"
          description="Mask your shooter, edit clips, and keep them in a private library"
          detail="Personal clips · NBA collection unavailable"
          secondaryHref="#jumper/create"
          secondaryLabel="Create a clip"
          href="#jumper"
        >
          <JumperDemo />
        </Feature>
      </div>
      <aside className="home-local" aria-labelledby="home-local-heading">
        <div>
          <h2 id="home-local-heading">Run ARCade Hoops locally</h2>
          <p>
            Get full shot analysis and native clip processing while keeping
            personal media on your device
          </p>
        </div>
        <a
          href="https://github.com/stiwarilbj/Arc-Shot-Evaluator#run-the-downloaded-app"
          className="home-feature-link"
        >
          Get the downloaded app <ArrowRight size={18} aria-hidden="true" />
        </a>
      </aside>
    </main>
  );
}

function HomeLink({
  href,
  className,
  children,
}: {
  href: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      className={className}
      onClick={(event) => {
        if (
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          !event.altKey &&
          event.button === 0
        )
          window.scrollTo(0, 0);
      }}
    >
      {children}
    </a>
  );
}

function Feature({
  number,
  title,
  description,
  detail,
  secondaryHref,
  secondaryLabel,
  href,
  children,
}: {
  number: string;
  title: string;
  description: string;
  detail: string;
  secondaryHref?: string;
  secondaryLabel?: string;
  href: string;
  children: ReactNode;
}) {
  return (
    <section
      className="home-feature"
      aria-labelledby={`home-feature-${number}`}
    >
      <div className="home-feature-copy">
        <span className="home-feature-number" aria-hidden="true">
          {number}
        </span>
        <h2 id={`home-feature-${number}`}>{title}</h2>
        <p className="home-feature-description">{description}</p>
        <p className="home-feature-detail">{detail}</p>
        <div className="home-feature-actions">
          <HomeLink className="home-feature-link" href={href}>
            Open {title}
            <ArrowRight size={18} aria-hidden="true" />
          </HomeLink>
          {secondaryHref ? (
            <HomeLink className="home-secondary-link" href={secondaryHref}>
              {secondaryLabel}
            </HomeLink>
          ) : null}
        </div>
      </div>
      <div className="home-preview">
        {children}
      </div>
    </section>
  );
}

function DemoButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className="home-demo-button"
      type="button"
      onClick={onClick}
      aria-pressed={active}
    >
      {active ? (
        <RotateCcw size={14} aria-hidden="true" />
      ) : (
        <Play size={14} aria-hidden="true" />
      )}
      {children}
    </button>
  );
}

function ShotDemo() {
  const [released, setReleased] = useState(false);
  return (
    <>
      <svg
        className="home-demo-svg"
        viewBox="0 0 480 220"
        role="img"
        aria-label={
          released
            ? "Illustrative shot after release, with the ball at the hoop"
            : "Illustrative shooting pose and ball trajectory"
        }
      >
        <path
          className="home-court-line"
          d="M25 194H455 M422 43V91 M406 91H438 M409 95L415 117H430L436 95 M414 102H432 M417 110H431"
        />
        <path className="home-demo-arc" d="M188 62Q320 -22 420 91" />
        <g className="home-skeleton" opacity=".25" transform="translate(-75 0)">
          <circle cx="165" cy="103" r="9" />
          <path d="M166 114L159 151L143 173L133 194 M159 151L181 171L184 194 M166 118L183 129L199 115 M165 118L154 133L183 144" />
        </g>
        <g className="home-skeleton">
          <circle cx="169" cy="91" r="9" />
          <path d="M171 103L175 145L164 172L156 194 M175 145L190 170L188 194 M172 108L183 83L185 64 M172 109L163 86L181 61" />
          {[
            [171, 103],
            [175, 145],
            [164, 172],
            [190, 170],
            [183, 83],
            [163, 86],
          ].map(([cx, cy]) => (
            <circle
              className="home-pose-joint"
              key={`${cx}-${cy}`}
              cx={cx}
              cy={cy}
              r="3"
            />
          ))}
        </g>
        <circle
          className={`home-shot-ball ${released ? "is-released" : ""}`}
          cx="188"
          cy="61"
          r="7"
        />
      </svg>
      <DemoButton active={released} onClick={() => setReleased(!released)}>
        {released ? "Reset preview" : "Preview release"}
      </DemoButton>
    </>
  );
}

function Court({ children, label }: { children: ReactNode; label: string }) {
  return (
    <svg
      className="home-demo-svg"
      viewBox="0 0 480 220"
      role="img"
      aria-label={label}
    >
      <g className="home-court-line">
        <path d="M60 14H420V205H60Z M195 14V106H285V14 M215 29H265 M240 14V25 M76 14V48Q84 173 240 181Q396 173 404 48V14" />
        <circle cx="240" cy="106" r="32" />
        <circle className="home-rim" cx="240" cy="37" r="7" />
      </g>
      {children}
    </svg>
  );
}

function Marker({
  x,
  y,
  n,
  defense = false,
  moved = false,
  dx = 0,
  dy = 0,
}: {
  x: number;
  y: number;
  n: number;
  defense?: boolean;
  moved?: boolean;
  dx?: number;
  dy?: number;
}) {
  return (
    <g
      className={`home-marker ${defense ? "home-defender" : ""}`}
      style={{
        transform: `translate(${x + (moved ? dx : 0)}px, ${y + (moved ? dy : 0)}px)`,
      }}
    >
      {defense ? <path d="M0 -13L13 0L0 13L-13 0Z" /> : <circle r="13" />}
      <text y="4" textAnchor="middle">
        {n}
      </text>
    </g>
  );
}

function PlayDemo() {
  const [moved, setMoved] = useState(false);
  return (
    <>
      <Court
        label={
          moved
            ? "Illustrative play after the ball handler uses a screen"
            : "Illustrative play with five players and a screen route"
        }
      >
        <path
          className="home-route"
          d="M212 177Q258 167 278 132 M270 137L278 132L279 142 M245 126L256 146 M239 130L250 124"
        />
        <path
          className="home-pass"
          d="M282 129L363 119 M354 115L363 119L356 126"
        />
        <Marker x={210} y={177} n={1} moved={moved} dx={68} dy={-45} />
        <Marker x={110} y={120} n={2} />
        <Marker x={370} y={120} n={3} />
        <Marker x={135} y={50} n={4} />
        <Marker x={240} y={122} n={5} />
      </Court>
      <DemoButton active={moved} onClick={() => setMoved(!moved)}>
        {moved ? "Reset preview" : "Preview movement"}
      </DemoButton>
    </>
  );
}

function CounterDemo() {
  const [slip, setSlip] = useState(false);
  return (
    <>
      <div
        className="home-demo-options"
        role="group"
        aria-label="Counter Lab illustration"
      >
        <button
          type="button"
          aria-pressed={!slip}
          onClick={() => setSlip(false)}
        >
          Switch
        </button>
        <button type="button" aria-pressed={slip} onClick={() => setSlip(true)}>
          Slip
        </button>
      </div>
      <Court
        label={
          slip
            ? "Illustrative slip: the screener moves toward the basket"
            : "Illustrative switch: defenders exchange assignments at the screen"
        }
      >
        <path
          className="home-pass"
          d={
            slip
              ? "M275 159L254 79 M251 89L254 79L260 88"
              : "M282 133Q266 112 246 115 M255 109L246 115L256 120"
          }
        />
        <path
          className="home-route"
          d={
            slip
              ? "M225 134Q214 86 241 58 M232 62L241 58L240 68"
              : "M208 174Q254 174 278 146 M269 148L278 146L277 156"
          }
        />
        <Marker x={208} y={174} n={1} moved={slip} dx={67} dy={-15} />
        <Marker x={225} y={134} n={5} moved={slip} dx={16} dy={-67} />
        <Marker x={254} y={113} n={1} defense />
        <Marker x={294} y={139} n={5} defense />
      </Court>
      <p className="home-demo-note" aria-live="polite">
        {slip
          ? "A slip sends the screener toward the rim"
          : "A switch exchanges defensive assignments"}
      </p>
    </>
  );
}

function JumperDemo() {
  const [target, setTarget] = useState(0);
  return (
    <>
      <svg
        className="home-demo-svg home-silhouette-demo"
        viewBox="0 0 480 220"
        role="img"
        aria-label={`Silhouette illustration: player ${target + 1} is black and the other players are gray`}
      >
        {[100, 240, 380].map((x, index) => (
          <g
            key={x}
            transform={`translate(${x} 0)`}
            fill={target === index ? "#000000" : "#777777"}
          >
            <circle cx="0" cy="70" r="11" />
            <path d="M-9 82Q0 77 9 82L13 122L10 141H-12L-13 120Z" />
            <path d="M-8 87L-21 66L-12 44L-7 46L-14 66L1 85Z" />
            <path d="M7 87L19 65L11 43L16 41L27 66L14 95Z" />
            <path d="M-10 137L-17 177L-23 194H-11L-7 180L1 145Z" />
            <path d="M3 138L13 177L9 194H21L23 178L12 136Z" />
          </g>
        ))}
      </svg>
      <button
        className="home-demo-button"
        type="button"
        onClick={() => setTarget((target + 1) % 3)}
      >
        <RotateCcw size={14} aria-hidden="true" />
        Change shooter
      </button>
    </>
  );
}
