import Link from "next/link"
import { getGlobalInbox } from "@/lib/messages"
import { MESSAGE_FOLDERS, groupMessagesByOrder, isConversationInFolder } from "@/lib/present/messages"
import { AppFrame } from "../components/app-frame"
import { MessageThreads } from "../components/message-threads"

export const dynamic = "force-dynamic"
export const metadata = { title: "Messages · Control Room" }

export default async function MessagesPage({ searchParams }: {
  searchParams: Promise<{ view?: string | string[] }>
}) {
  const [messages, query] = await Promise.all([getGlobalInbox(), searchParams])
  const folder = MESSAGE_FOLDERS.find((entry) => entry.id === query.view) ?? MESSAGE_FOLDERS.find((entry) => entry.id === "all")!
  const conversations = groupMessagesByOrder(messages)
  const visible = conversations.filter((conversation) => isConversationInFolder(conversation, folder.id))

  return <AppFrame section="inbox">
    <main className="page messages-page">
      <header className="messages-header">
        <p className="eyebrow">BAHN / OPERATIONS</p>
        <h1 className="page-title small">Messages</h1>
        <p className="intro">One conversation per delivery, latest activity first.</p>
      </header>
      <nav className="message-folders" aria-label="Message views">
        {MESSAGE_FOLDERS.map((entry) => <Link key={entry.id} href={`/inbox?view=${entry.id}`} prefetch={false}
          className={`message-folder${entry.id === folder.id ? " active" : ""}`} aria-current={entry.id === folder.id ? "page" : undefined}>
          {entry.label}<span className="control-count">{conversations.filter((conversation) => isConversationInFolder(conversation, entry.id)).length}</span>
        </Link>)}
      </nav>
      <section className="inbox" aria-labelledby="message-list-title">
        <div className="sec-head"><h2 id="message-list-title">Conversations <span className="control-count">{visible.length}</span></h2><span className="note">{folder.description}</span></div>
        {visible.length ? <MessageThreads key={folder.id} conversations={visible} /> : <div className="control-empty"><h3>No conversations here yet</h3><p>{folder.id === "all" ? "Orders with recorded messages will appear here." : "No conversations match this view."}</p>
          {folder.id !== "all" && <Link href="/inbox?view=all" className="ref-link">View all messages</Link>}</div>}
      </section>
    </main>
  </AppFrame>
}
