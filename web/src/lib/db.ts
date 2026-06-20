import { openDB, type IDBPDatabase } from "idb";

/** Local-only persistence. Private keys (the Olm account + session pickles) and
 * decrypted message history live here, in the browser's origin-isolated store —
 * never on the server. */

export interface StoredSessions {
  identityKey: string;
  pickles: string[];
}
export interface StoredConversation {
  peerUserId: string;
  username: string;
}
export interface StoredMessageRec {
  id: string;
  convId: string;
  dir: "in" | "out";
  body: string;
  sentAt: number;
  status?: "sending" | "sent" | "failed";
}

let dbp: Promise<IDBPDatabase> | null = null;
function database(): Promise<IDBPDatabase> {
  if (!dbp) {
    dbp = openDB("fastmessage", 1, {
      upgrade(db) {
        db.createObjectStore("kv");
        db.createObjectStore("sessions", { keyPath: "identityKey" });
        db.createObjectStore("conversations", { keyPath: "peerUserId" });
        const m = db.createObjectStore("messages", { keyPath: "id" });
        m.createIndex("convId", "convId");
      },
    });
  }
  return dbp;
}

export const storage = {
  async getKV<T>(key: string): Promise<T | undefined> {
    return (await database()).get("kv", key) as Promise<T | undefined>;
  },
  async setKV(key: string, val: unknown): Promise<void> {
    await (await database()).put("kv", val, key);
  },
  async delKV(key: string): Promise<void> {
    await (await database()).delete("kv", key);
  },

  async putSessions(s: StoredSessions): Promise<void> {
    await (await database()).put("sessions", s);
  },
  async allSessions(): Promise<StoredSessions[]> {
    return (await database()).getAll("sessions") as Promise<StoredSessions[]>;
  },

  async putConversation(c: StoredConversation): Promise<void> {
    await (await database()).put("conversations", c);
  },
  async allConversations(): Promise<StoredConversation[]> {
    return (await database()).getAll("conversations") as Promise<
      StoredConversation[]
    >;
  },

  async putMessage(m: StoredMessageRec): Promise<void> {
    await (await database()).put("messages", m);
  },
  async messagesFor(convId: string): Promise<StoredMessageRec[]> {
    return (await database()).getAllFromIndex(
      "messages",
      "convId",
      convId,
    ) as Promise<StoredMessageRec[]>;
  },

  async clearAll(): Promise<void> {
    const db = await database();
    await Promise.all(
      ["kv", "sessions", "conversations", "messages"].map((s) => db.clear(s)),
    );
  },
};
