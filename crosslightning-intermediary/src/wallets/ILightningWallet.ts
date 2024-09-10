import * as BN from "bn.js";

export type IncomingLightningNetworkPayment = {
    createdAt: number,
    confirmedAt: number,

    createdHeight: number,
    timeout: number,

    status: "held" | "canceled" | "confirmed"

    mtokens: BN
}

export type LightningNetworkInvoice = {
    id: string,
    request: string,
    secret?: string,

    cltvDelta: number,
    mtokens: BN,

    createdAt: number,
    expiresAt: number,

    description: string,
    descriptionHash?: string,

    payments: IncomingLightningNetworkPayment[],

    status: "unpaid" | "held" | "canceled" | "confirmed"
};

export type OutgoingLightningNetworkPayment = {
    failedReason?: "insufficient_balance" | "invalid_payment" | "pathfinding_timeout" | "route_not_found",
    status: "confirmed" | "failed" | "pending",
    secret?: string,
    feeMtokens?: BN
};

export type LightningNetworkChannel = {
    id: string,
    capacity: BN,
    isActive: boolean,

    localBalance: BN,
    localReserve: BN,
    remoteBalance: BN,
    remoteReserve: BN,
    unsettledBalance: BN,
    transactionId: string,
    transactionVout: number
};

export type HodlInvoiceInit = {
    description: string,
    cltvDelta: number,
    expiresAt: number,
    id: string,
    mtokens: BN,
    descriptionHash?: string
};

export type LightningPaymentInit = {
    request: string,
    maxFeeMtokens: BN,
    maxTimeoutHeight: number
};

export type LightningBalanceResponse = {
    localBalance: BN,
    remoteBalance: BN,
    unsettledBalance: BN
};

export type ProbeAndRouteInit = {
    request: string,
    amountMtokens: BN,
    maxFeeMtokens: BN,
    maxTimeoutHeight: number
}

export type ProbeAndRouteResponse = {
    confidence: number,
    feeMtokens: BN
}

export interface ILightningWallet {

    createHodlInvoice(init: HodlInvoiceInit): Promise<LightningNetworkInvoice>;
    getInvoice(paymentHash: string): Promise<LightningNetworkInvoice | null>;
    cancelHodlInvoice(paymentHash: string): Promise<void>;
    settleHodlInvoice(secret: string): Promise<void>;

    pay(init: LightningPaymentInit): Promise<void>;
    getPayment(paymentHash: string): Promise<OutgoingLightningNetworkPayment | null>
    waitForPayment(paymentHash: string, abortSignal?: AbortSignal): Promise<OutgoingLightningNetworkPayment>;
    probe(init: ProbeAndRouteInit): Promise<ProbeAndRouteResponse | null>;
    route(init: ProbeAndRouteInit): Promise<ProbeAndRouteResponse | null>;

    getChannels(activeOnly?: boolean): Promise<LightningNetworkChannel[]>;
    getLightningBalance(): Promise<LightningBalanceResponse>;

    getIdentityPublicKey(): Promise<string>;

}