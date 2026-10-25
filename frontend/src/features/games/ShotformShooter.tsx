import { poseAt, clamp, type Challenge, type Controls, type Pose, type V3 } from "./shotformMotion";
const point = (v: V3) => [205 + (v[0] + .55 * v[2]) * 170, 405 - v[1] * 170];
function Skeleton({ pose, highlight = -1, ghost = false, left }: { pose: Pose; highlight?: number; ghost?: boolean; left: boolean }) {
  const side = left ? "left" : "right";
  const line = (a: keyof Pose, b: keyof Pose, width: number, glow = false) => {
    const p = point(pose[a]), q = point(pose[b]);
    return <line key={`${a}-${b}-${glow}`} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} stroke={glow ? "var(--sj-accent)" : "currentColor"} strokeWidth={width} strokeLinecap="round" />;
  };
  const head = point(pose.head), chest = point(pose.chest), hips = point(pose.hips);
  return <g opacity={ghost ? .16 : 1} className={ghost ? "sj-ghost" : "sj-body"}>
    <line x1={hips[0]} y1={hips[1]} x2={chest[0]} y2={chest[1]} stroke="currentColor" strokeWidth="46" strokeLinecap="round" />
    <circle cx={head[0]} cy={head[1]} r="20" fill="currentColor" />
    {(["left", "right"] as const).map(s => <g key={s}>{line(`${s}Hip`, `${s}Knee`, 23)}{line(`${s}Knee`, `${s}Ankle`, 18)}{line(`${s}Ankle`, `${s}Toe`, 16)}{line(`${s}Shoulder`, `${s}Elbow`, 18)}{line(`${s}Elbow`, `${s}Wrist`, 15)}{line(`${s}Wrist`, `${s}Hand`, 13)}</g>)}
    {!ghost && highlight === 0 && <g opacity=".8">{line("hips", "chest", 8, true)}{line("leftAnkle", "rightAnkle", 5, true)}</g>}
    {!ghost && highlight === 1 && line(`${side}Shoulder`, `${side}Elbow`, 7, true)}
    {!ghost && highlight === 2 && line(`${side}Wrist`, `${side}Hand`, 7, true)}
  </g>;
}
export default function ShotformShooter({ challenge, controls, previous, time, highlight }: { challenge: Challenge; controls: Controls; previous: Controls | null; time: number; highlight: number }) {
  const repetition = Math.min(2, Math.floor(time / 1.6)), t = clamp((time - repetition * 1.6) / 1.6, 0, 1);
  const pose = poseAt(challenge, controls, repetition, t), hand = point(pose[challenge.leftHanded ? "leftHand" : "rightHand"]);
  const u = clamp((t - .52) / .48, 0, 1), ball = t < .52 ? hand : [hand[0] + (470 - hand[0]) * u, hand[1] + (169 - hand[1]) * u - 150 * Math.sin(Math.PI * u)];
  return <svg className="sj-court" viewBox="0 0 620 440" role="img" aria-label={`Animated shooter, repetition ${repetition + 1} of 3${highlight >= 0 ? ", orange marks the area to inspect" : ""}`}>
    <path d="M35 414H585 M70 427L550 395 M510 180V411" fill="none" stroke="var(--sj-line)" strokeWidth="2" />
    <path d="M530 110V183H490" fill="none" stroke="var(--sj-muted)" strokeWidth="5" />
    <ellipse cx="470" cy="183" rx="24" ry="7" fill="none" stroke="var(--sj-accent)" strokeWidth="4" />
    <path d="M450 187L459 217H480L490 187M459 217L476 189M480 217L463 189" fill="none" stroke="var(--sj-line)" strokeWidth="2" />
    {previous && <Skeleton pose={poseAt(challenge, previous, repetition, t)} ghost left={challenge.leftHanded} />}
    <Skeleton pose={pose} highlight={highlight} left={challenge.leftHanded} />
    <circle cx={ball[0]} cy={ball[1]} r="13" fill="var(--sj-accent)" stroke="#492516" strokeWidth="1.5" />
    <path d={`M${ball[0] - 12} ${ball[1]}h24M${ball[0]} ${ball[1] - 12}v24`} stroke="#492516" fill="none" />
    <text x="32" y="34" fill="var(--sj-muted)" fontSize="13">REPETITION {repetition + 1} / 3</text>
    {previous && <text x="32" y="56" fill="var(--sj-muted)" fontSize="12">Faint outline: previous test</text>}
  </svg>;
}
