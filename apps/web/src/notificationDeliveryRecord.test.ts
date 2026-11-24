import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  __setNotificationDeliverySinkForTests,
  deliveryRecordAttributes,
  recordNotificationDelivery,
  type NotificationDeliveryRecord,
} from "./notificationDeliveryRecord";

const record: NotificationDeliveryRecord = {
  machine: "env-m4",
  servingMachine: "env-m5",
  threadId: "thread-1",
  kind: "action:message",
  focused: true,
  openThread: false,
  ownerMachine: "env-m5",
  targetClientId: null,
  targetReason: null,
  ownerInUse: true,
  holdWhy: "owner-in-use",
  phase: "first",
  outcome: "held-back",
  why: "owner-in-use",
};

afterEach(() => __setNotificationDeliverySinkForTests(null));

describe("notification delivery record (1436 AC-05)", () => {
  it("leaves out what is unknown", () => {
    const attributes = deliveryRecordAttributes(record);
    expect(attributes).not.toHaveProperty("notification.target_client_id");
    expect(attributes["notification.owner_in_use"]).toBe(true);
  });

  it("writes ids, kinds and reasons only, under fixed keys", () => {
    const attributes = deliveryRecordAttributes({
      ...record,
      targetClientId: "client-m4",
      targetReason: "foreground",
    });
    expect(Object.keys(attributes).sort()).toEqual(
      [
        "notification.focused",
        "notification.hold_why",
        "notification.kind",
        "notification.machine",
        "notification.open_thread",
        "notification.outcome",
        "notification.owner_in_use",
        "notification.owner_machine",
        "notification.phase",
        "notification.serving_machine",
        "notification.target_client_id",
        "notification.target_reason",
        "notification.thread_id",
        "notification.why",
      ].sort(),
    );
    expect(attributes["notification.outcome"]).toBe("held-back");
  });

  it("never throws into the alert path", () => {
    __setNotificationDeliverySinkForTests(() => {
      throw new Error("sink down");
    });
    expect(() => recordNotificationDelivery(record)).not.toThrow();
  });

  it("writes through the default trace sink without a configured exporter", () => {
    expect(() => recordNotificationDelivery(record)).not.toThrow();
  });
});
