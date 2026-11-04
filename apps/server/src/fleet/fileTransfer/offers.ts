// @effect-diagnostics nodeBuiltinImport:off - offer ids, and removing a refused file.
/**
 * This machine's side of a transfer another machine drives: what it has agreed
 * to serve or receive, for whom. An offer is good only for the machine that
 * asked for it, and lapses an hour after its last use.
 */
import * as NodeCrypto from "node:crypto";

import {
  assertRoomFor,
  CHUNK_BYTES,
  chunkCount,
  FileTransferRefusal,
  formatBytes,
  IncomingFile,
  inboxFolder,
  isCredentialLocation,
  isWithin,
  landingPath,
  MAX_FILE_BYTES,
  MAX_SECRET_FILE_BYTES,
  type PinnedFile,
  pinResolved,
  readPinned,
  resolveFile,
  safeFileName,
  sha256Pinned,
  sweepStaging,
} from "./files.ts";
import { newReceivingKey, type ReceivingKey, seal, unseal } from "./seal.ts";

const OFFER_IDLE_MS = 60 * 60 * 1000;
/** A finished offer stays only long enough to repeat its answer. */
const FINISHED_IDLE_MS = 5 * 60 * 1000;
const MAX_OFFERS = 64;
/** A coordinator's next chunk arrives well within this, so an offer idle longer can give way. */
const EVICTABLE_IDLE_MS = 2 * 60 * 1000;

const writeFailure = (cause: unknown) =>
  cause instanceof FileTransferRefusal
    ? cause
    : new FileTransferRefusal(
        (cause as NodeJS.ErrnoException).code === "ENOSPC"
          ? "This machine ran out of disk space; nothing was kept. Clear space there, or rebuild the file where there is room."
          : "The file could not be written or opened here; nothing was kept.",
      );

export interface OfferCaller {
  /** The machine asking; each offer answers only to it. */
  readonly coordinatorEnvironmentId: string;
  readonly coordinatorLabel: string;
  /** Only a full-access grant of the owner's own machine may carry a secret or choose a folder. */
  readonly mayCarrySecrets: boolean;
  /** The folders the machine's grant already reaches here, real paths. */
  readonly roots: ReadonlyArray<string>;
}

interface Serving {
  readonly kind: "serve";
  readonly pin: PinnedFile;
  finished: boolean;
}
interface Receiving {
  readonly kind: "receive";
  readonly incoming: IncomingFile;
  readonly sha256: string | null;
  readonly chunks: number;
  readonly key: ReceivingKey | null;
  /** Set by the last chunk; a repeat of it after a lost answer gets the same outcome. */
  finishing: Promise<string> | null;
  cancelled: boolean;
}
type Offer = (Serving | Receiving) & { readonly owner: string; lastUsed: number };

export interface GetOfferAnswer {
  readonly offerId: string | null;
  readonly name: string;
  readonly sizeBytes: number;
  readonly sha256: string | null;
  readonly secret: boolean;
  readonly sealed: string | null;
  /** Where the asked path really leads: what the owner is shown and approves. */
  readonly path: string;
}

export class FileOffers {
  private readonly offers = new Map<string, Offer>();
  private readonly baseDir: string;
  private readonly stateDir: string;
  private readonly now: () => number;

  constructor(baseDir: string, stateDir: string, now: () => number = Date.now) {
    this.baseDir = baseDir;
    this.stateDir = stateDir;
    this.now = now;
  }

  private async close(id: string, offer: Offer) {
    this.offers.delete(id);
    if (offer.kind !== "receive") return;
    offer.cancelled = true;
    if (offer.finishing === null) await offer.incoming.abandon();
  }

  private async sweep() {
    await sweepStaging(inboxFolder(this.stateDir), this.now());
    for (const [id, offer] of this.offers) {
      const finished = offer.kind === "serve" ? offer.finished : offer.finishing !== null;
      if (this.now() - offer.lastUsed >= (finished ? FINISHED_IDLE_MS : OFFER_IDLE_MS))
        await this.close(id, offer);
    }
    // A served file holds nothing open, so an idle one gives way before anyone is refused.
    for (const [id, offer] of this.offers) {
      if (this.offers.size < MAX_OFFERS) break;
      if (
        offer.kind === "serve" &&
        (offer.finished || this.now() - offer.lastUsed >= EVICTABLE_IDLE_MS)
      )
        await this.close(id, offer);
    }
    if (this.offers.size >= MAX_OFFERS)
      throw new FileTransferRefusal("This machine is busy with other transfers. Try again soon.");
  }

  private inRoots(caller: OfferCaller, real: string) {
    return [...caller.roots, inboxFolder(this.stateDir)].some((root) => isWithin(root, real));
  }

  async offerGet(
    caller: OfferCaller,
    input: { readonly path: string; readonly recipientKey?: string | undefined },
  ): Promise<GetOfferAnswer> {
    await this.sweep();
    const { real } = await resolveFile(input.path);
    if (
      !this.inRoots(caller, real) ||
      (await isCredentialLocation(real, this.baseDir, this.stateDir))
    )
      throw new FileTransferRefusal(
        `${input.path} is outside what ${caller.coordinatorLabel} may reach on this machine. Copy it into the project folder there, or into the transfer inbox.`,
      );
    const pin = await pinResolved(real);
    const size = pin.size;
    const name = safeFileName(real);
    if (pin.secret) {
      if (!caller.mayCarrySecrets)
        throw new FileTransferRefusal(
          `${input.path} looks like a secret, and this machine lets ${caller.coordinatorLabel} carry secrets only under a full-access grant of the owner's own machine.`,
        );
      if (size > MAX_SECRET_FILE_BYTES)
        throw new FileTransferRefusal(
          `${input.path} looks like a secret and is ${formatBytes(size)}; secrets are limited to 1 MB.`,
        );
      return {
        offerId: null,
        path: real,
        name,
        sizeBytes: size,
        sha256: null,
        secret: true,
        sealed:
          input.recipientKey === undefined
            ? null
            : seal(await readPinned(pin, 0), input.recipientKey),
      };
    }
    const offerId = NodeCrypto.randomUUID();
    const sha256 = await sha256Pinned(pin);
    this.offers.set(offerId, {
      kind: "serve",
      pin,
      finished: false,
      owner: caller.coordinatorEnvironmentId,
      lastUsed: this.now(),
    });
    return { offerId, path: real, name, sizeBytes: size, sha256, secret: false, sealed: null };
  }

  async offerSend(
    caller: OfferCaller,
    input: {
      readonly name: string;
      readonly sizeBytes: number;
      readonly sha256?: string | undefined;
      readonly secret: boolean;
      readonly destinationPath?: string | undefined;
    },
  ) {
    await this.sweep();
    if (input.sizeBytes > (input.secret ? MAX_SECRET_FILE_BYTES : MAX_FILE_BYTES))
      throw new FileTransferRefusal(
        input.secret
          ? "Secrets are limited to 1 MB."
          : `A ${formatBytes(input.sizeBytes)} file is over the 4 GB limit.`,
      );
    if (input.secret && !caller.mayCarrySecrets)
      throw new FileTransferRefusal(
        `This machine lets ${caller.coordinatorLabel} carry secrets only under a full-access grant of the owner's own machine.`,
      );
    // A file written into a project can change what agents there run.
    if (input.destinationPath !== undefined && !caller.mayCarrySecrets)
      throw new FileTransferRefusal(
        `This machine lets ${caller.coordinatorLabel} choose a folder only under a full-access grant of the owner's own machine. Omit destinationPath to receive it in the transfer inbox.`,
      );
    const offerId = NodeCrypto.randomUUID();
    const inbox = inboxFolder(this.stateDir);
    const final = await landingPath({
      name: input.name,
      destinationPath: input.destinationPath,
      roots: caller.roots,
      inbox,
      id: offerId,
    });
    if (await isCredentialLocation(final, this.baseDir, this.stateDir))
      throw new FileTransferRefusal(
        `${input.destinationPath ?? final} is in a credential or app folder. Omit destinationPath to receive it in the transfer inbox.`,
      );
    await assertRoomFor(inbox, input.sizeBytes, "This machine");
    await assertRoomFor(final, input.sizeBytes, "This machine");
    const incoming = await IncomingFile.open({
      final,
      size: input.sizeBytes,
      secret: input.secret,
      inbox,
    });
    const key = input.secret ? newReceivingKey() : null;
    this.offers.set(offerId, {
      kind: "receive",
      incoming,
      sha256: input.sha256 ?? null,
      chunks: chunkCount(input.sizeBytes),
      key,
      finishing: null,
      cancelled: false,
      owner: caller.coordinatorEnvironmentId,
      lastUsed: this.now(),
    });
    return { offerId, path: final, recipientKey: key?.publicKey ?? null };
  }

  private held(caller: OfferCaller, offerId: string) {
    const offer = this.offers.get(offerId);
    // The same words for a lapsed offer and another machine's.
    if (offer === undefined || offer.owner !== caller.coordinatorEnvironmentId)
      throw new FileTransferRefusal("That transfer is no longer open here. Start it again.");
    offer.lastUsed = this.now();
    return offer;
  }

  async read(caller: OfferCaller, offerId: string, index: number) {
    const offer = this.held(caller, offerId);
    if (offer.kind !== "serve")
      throw new FileTransferRefusal("That transfer sends to this machine.");
    const bytes = await readPinned(offer.pin, index);
    const last = (index + 1) * CHUNK_BYTES >= offer.pin.size;
    if (last) offer.finished = true;
    return { data: bytes.toString("base64"), last };
  }

  /** The sender gave up: nothing it sent is kept. */
  async abort(caller: OfferCaller, offerId: string) {
    const offer = this.offers.get(offerId);
    if (offer !== undefined && offer.owner === caller.coordinatorEnvironmentId)
      await this.close(offerId, offer);
  }

  async write(
    caller: OfferCaller,
    input: {
      readonly offerId: string;
      readonly index: number;
      readonly data?: string | undefined;
      readonly sealed?: string | undefined;
    },
  ) {
    const offer = this.held(caller, input.offerId);
    if (offer.kind !== "receive")
      throw new FileTransferRefusal("That transfer serves from this machine.");
    if (offer.finishing !== null) return { path: await offer.finishing };
    if ((offer.key !== null) !== (input.sealed !== undefined))
      throw new FileTransferRefusal("A secret must arrive sealed, and only a secret may.");
    let bytes: Buffer;
    try {
      bytes =
        offer.key !== null
          ? unseal(input.sealed!, offer.key)
          : Buffer.from(input.data ?? "", "base64");
    } catch (cause) {
      await this.close(input.offerId, offer);
      throw writeFailure(cause);
    }
    const finalChunk = input.index + 1 >= offer.chunks;
    const written = offer.incoming.write(input.index, bytes).catch(async (cause: unknown) => {
      if (finalChunk) offer.finishing = null;
      await this.close(input.offerId, offer);
      throw writeFailure(cause);
    });
    if (!finalChunk) {
      await written;
      return { path: null };
    }
    // Reserve finalization before yielding. An overlapping retry joins this write and publish.
    offer.finishing = written.then(async () => {
      if (offer.cancelled) {
        await offer.incoming.abandon();
        throw new FileTransferRefusal("That transfer was cancelled before publication.");
      }
      return offer.incoming.finish(offer.sha256).catch((cause: unknown) => {
        throw writeFailure(cause);
      });
    });
    return { path: await offer.finishing };
  }
}
