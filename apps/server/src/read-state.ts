import type { Message } from "@myclass/shared";
import type { UserRecord } from "./store.js";

/** How many opened message ids are kept; older ones are already read on eClass or long gone. */
const MAX_READ_MESSAGES = 500;

/**
 * The student opened a message in myClass: it counts as read from now on, and the
 * "new message" notification about it goes away. Older notifications carry no message id,
 * so those are matched by the "sender: subject" title the poller gave them.
 */
export function markMessageRead(rec: UserRecord, message: Pick<Message, "id" | "sender" | "subject">): void {
  const read = (rec.readMessages ?? []).filter((id) => id !== message.id);
  read.push(message.id);
  rec.readMessages = read.slice(-MAX_READ_MESSAGES);
  const legacyTitle = `${message.sender}: ${message.subject}`;
  rec.notifications = rec.notifications.filter(
    (n) => !(n.kind === "message" && (n.messageId ? n.messageId === message.id : n.title === legacyTitle)),
  );
}
