import { openDB, type IDBPDatabase } from "idb";

/** Local-only persistence. Private keys (the Olm account + session pickles) and
 * decrypted message history live here, in the browser's origin-isolated store —
 * never on the server. */

export interface StoredSessions {
  identityKey: string;
  pickles: string[];
}
export interface StoredConversation {
  id: string;
  kind: "dm" | "group";
  title: string;
}
export interface StoredMessageRec {
  id: string;
  convId: string;
  dir: "in" | "out";
  body: string;
  sentAt: number;
  sender?: string;
  status?: "sending" | "sent" | "failed";
}
/** Outbound Megolm session for a group (the sender's ratchet). */
export interface StoredGroupOut {
  groupId: string;
  sessionId: string;
  pickle: string;
  deliveredTo: string[]; // device identity keys that already have the key
  memberSig: string; // signature of the member set, for rotation
}
/** Inbound Megolm session (a member's view of someone's group ratchet). */
export interface StoredGroupIn {
  sessionId: string;
  groupId: string;
  pickle: string;
}

let dbp: Promise<IDBPDatabase> | null = null;
function database(): Promise<IDBPDatabase> {
  if (!dbp) {
    dbp = openDB("fastmessage", 2, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
        if (!db.objectStoreNames.contains("sessions"))
          db.createObjectStore("sessions", { keyPath: "identityKey" });
        // Conversation key changed from peerUserId -> id (dm or group).
        if (db.objectStoreNames.contains("conversations"))
          db.deleteObjectStore("conversations");
        db.createObjectStore("conversations", { keyPath: "id" });
        if (!db.objectStoreNames.contains("messages")) {
          const m = db.createObjectStore("messages", { keyPath: "id" });
          m.createIndex("convId", "convId");
        }
        if (!db.objectStoreNames.contains("groupOut"))
          db.createObjectStore("groupOut", { keyPath: "groupId" });
        if (!db.objectStoreNames.contains("groupIn"))
          db.createObjectStore("groupIn", { keyPath: "sessionId" });
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

  async putGroupOut(g: StoredGroupOut): Promise<void> {
    await (await database()).put("groupOut", g);
  },
  async getGroupOut(groupId: string): Promise<StoredGroupOut | undefined> {
    return (await database()).get("groupOut", groupId) as Promise<
      StoredGroupOut | undefined
    >;
  },
  async putGroupIn(g: StoredGroupIn): Promise<void> {
    await (await database()).put("groupIn", g);
  },
  async allGroupIn(): Promise<StoredGroupIn[]> {
    return (await database()).getAll("groupIn") as Promise<StoredGroupIn[]>;
  },

  async clearAll(): Promise<void> {
    const db = await database();
    await Promise.all(
      ["kv", "sessions", "conversations", "messages", "groupOut", "groupIn"].map(
        (s) => db.clear(s),
      ),
    );
  },
};
