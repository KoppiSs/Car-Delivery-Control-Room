"use client"

// Three kinds of statement, shown differently and never mixed:
// a fact says who said it and when; an agent reading says "Agent thinks" and
// lists its facts; a suggestion says "Suggested". Record ids stay out of the
// text: they are on hover and in the "Records used" toggle.

import type { ControlState } from "@/lib/present/control-table"
import type { CaseStatements, SourceRef } from "@/lib/present/statements"
import { fmtDateTime, fmtLong } from "@/lib/present/time"
import styles from "./statements.module.css"

const recordLabel = (source: SourceRef) => `${source.collection} · ${source.recordId}`

/** "Driver, 21 Oct 10:50 UTC". A record without a time says so. */
export function SourceTag({ source }: { source: SourceRef }) {
  return <span className={styles.source} title={`${recordLabel(source)}${source.at ? ` · ${fmtLong(source.at)}` : ""}`}>
    {source.who}, {source.at ? <time dateTime={source.at}>{fmtDateTime(source.at)}</time> : <span className={styles.notKnown}>time not recorded</span>}
  </span>
}

export function BasedOn({ sources, missing }: { sources: SourceRef[]; missing?: string[] }) {
  if (!sources.length && !missing?.length) return <p className={styles.basedOn}>Based on: <span className={styles.notKnown}>no facts given</span></p>
  return <p className={styles.basedOn}>Based on: {sources.map((source, index) => <span key={`${source.collection}:${source.recordId}`}>
    {index > 0 && "; "}{source.what} — <SourceTag source={source} /></span>)}
    {missing?.length ? <span className={styles.notKnown} title={missing.join(", ")}>{sources.length ? "; " : ""}{missing.length} record{missing.length === 1 ? "" : "s"} not found on this order</span> : null}
  </p>
}

export function Reading({ text, sources, missing }: { text: string; sources: SourceRef[]; missing?: string[] }) {
  return <li className={styles.reading}>
    <span className={styles.kind}>Agent thinks</span>
    <p>{text}</p>
    <BasedOn sources={sources} missing={missing} />
  </li>
}

export function Suggestion({ children }: { children: React.ReactNode }) {
  return <div className={styles.suggestion}><span className={styles.kind}>Suggested</span><div>{children}</div></div>
}

/** Facts, unknowns, the agent's readings and suggestions for the top of the order. */
export function CaseSummary({ statements, control }: { statements: CaseStatements; control?: ControlState | null }) {
  const { facts, unknowns, readings, suggestions } = statements
  if (!facts.length && !unknowns.length && !readings.length && !suggestions.length && !control) return null
  const used = [...new Map(facts.map(({ source }) => [recordLabel(source), source])).values()]
  return <section className={styles.summary} aria-labelledby="case-summary-title">
    <h2 id="case-summary-title">What we know</h2>
    {control && <p className={styles.control}>{control.row ? <>Control table: <b>{control.note}</b>{control.row.flag ? ` · ${control.row.flag.text}` : ""}</>
      : <>Not in the control table: {control.note}</>}</p>}
    {facts.length > 0 && <ul className={styles.facts}>{facts.map(({ source }) => <li key={recordLabel(source)} className={styles.fact}>
      <p>{source.what}</p><SourceTag source={source} />
    </li>)}</ul>}
    {unknowns.length > 0 && <ul className={styles.facts}>{unknowns.map((entry) => <li key={entry.subject} className={styles.unknown}>
      <p>{entry.subject}: <b>not known</b>{entry.note ? `, ${entry.note}` : ""}</p>
      {entry.basedOn[0] && <SourceTag source={entry.basedOn[0]} />}
    </li>)}</ul>}
    {readings.length > 0 && <ul className={styles.readings}>{readings.map((entry) =>
      <Reading key={entry.text} text={entry.text} sources={entry.basedOn} />)}</ul>}
    {suggestions.length > 0 && <Suggestion>
      {suggestions.length === 1 ? <p>{suggestions[0].text}</p> : <ul>{suggestions.map((entry) => <li key={entry.text}>{entry.text}</li>)}</ul>}
    </Suggestion>}
    {used.length > 0 && <details className={styles.details}><summary>Records used</summary>
      <ul>{used.map((source) => <li key={recordLabel(source)}><span className="mono">{source.recordId}</span> · {source.collection}</li>)}</ul>
    </details>}
  </section>
}
