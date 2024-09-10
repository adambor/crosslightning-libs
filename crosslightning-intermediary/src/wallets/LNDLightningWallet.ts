import {
    HodlInvoiceInit,
    ILightningWallet,
    LightningBalanceResponse,
    LightningNetworkChannel,
    LightningNetworkInvoice,
    LightningPaymentInit,
    OutgoingLightningNetworkPayment,
    ProbeAndRouteInit,
    ProbeAndRouteResponse
} from "./ILightningWallet";
import {
    AuthenticatedLnd,
    cancelHodlInvoice, createHodlInvoice, getChannelBalance,
    getChannels,
    getInvoice,
    getPayment, getRouteToDestination,
    getWalletInfo,
    pay, probeForRoute,
    settleHodlInvoice, subscribeToPastPayment,
} from "lightning";
import {parsePaymentRequest} from "ln-service";
import * as BN from "bn.js";


export class LNDLightningWallet implements ILightningWallet{

    private lnd: AuthenticatedLnd;

    constructor(lnd: AuthenticatedLnd) {
        this.lnd = lnd;
    }

    async getInvoice(paymentHash: string): Promise<LightningNetworkInvoice | null> {
        const result = await getInvoice({id: paymentHash, lnd: this.lnd});
        if(result==null) return null;
        return {
            id: result.id,
            request: result.request,
            secret: result.secret,

            cltvDelta: result.cltv_delta,
            mtokens: new BN((result as any).mtokens),

            createdAt: new Date(result.created_at).getTime(),
            expiresAt: new Date(result.expires_at).getTime(),

            description: result.description,
            descriptionHash: result.description_hash,

            status: result.is_canceled ? "canceled" : result.is_confirmed ? "confirmed" : result.is_held ? "held" : "unpaid",

            payments: result.payments==null ? [] : result.payments.map(payment => {
                return {
                    createdAt: new Date(payment.created_at).getTime(),
                    confirmedAt: payment.confirmed_at==null ? null : new Date(payment.confirmed_at).getTime(),

                    createdHeight: payment.created_height,
                    timeout: payment.timeout,

                    status: payment.is_canceled ? "canceled" : payment.is_confirmed ? "confirmed" : payment.is_held ? "held" : null,

                    mtokens: new BN(payment.mtokens)
                }
            })
        };
    }

    cancelHodlInvoice(paymentHash: string): Promise<void> {
        return cancelHodlInvoice({
            id: paymentHash,
            lnd: this.lnd
        });
    }

    settleHodlInvoice(secret: string): Promise<void> {
        return settleHodlInvoice({
            secret,
            lnd: this.lnd
        });
    }

    async getChannels(activeOnly?: boolean): Promise<LightningNetworkChannel[]> {
        const {channels} = await getChannels({
            is_active: activeOnly,
            lnd: this.lnd
        });

        return channels.map(channel => {
            return {
                id: channel.id,
                capacity: new BN(channel.capacity),
                isActive: channel.is_active,

                localBalance: new BN(channel.local_balance),
                localReserve: new BN(channel.local_reserve),
                remoteBalance: new BN(channel.remote_balance),
                remoteReserve: new BN(channel.remote_reserve),
                unsettledBalance: new BN(channel.unsettled_balance),
                transactionId: channel.transaction_id,
                transactionVout: channel.transaction_vout
            }
        });
    }

    async getIdentityPublicKey(): Promise<string> {
        const info = await getWalletInfo({lnd: this.lnd});
        return info.public_key;
    }

    async createHodlInvoice(init: HodlInvoiceInit): Promise<LightningNetworkInvoice> {
        const invoice = await createHodlInvoice({
            description: init.description,
            cltv_delta: init.cltvDelta,
            expires_at: new Date(init.expiresAt).toISOString(),
            id: init.id,
            mtokens: init.mtokens.toString(10),
            description_hash: init.descriptionHash,
            lnd: this.lnd
        });

        return {
            id: invoice.id,
            request: invoice.request,
            secret: null,

            cltvDelta: init.cltvDelta,
            mtokens: init.mtokens,

            createdAt: new Date(invoice.created_at).getTime(),
            expiresAt: init.expiresAt,

            description: invoice.description,
            descriptionHash: init.descriptionHash,

            status: "unpaid",

            payments: []
        };
    }

    async getPayment(paymentHash: string): Promise<OutgoingLightningNetworkPayment | null> {
        try {
            const payment =  await getPayment({
                id: paymentHash,
                lnd: this.lnd
            });
            return {
                status: payment.is_confirmed ? "confirmed" : payment.is_pending ? "pending" : payment.is_failed ? "failed" : null,
                failedReason: payment.failed==null ? undefined :
                    payment.failed.is_invalid_payment ? "invalid_payment" :
                    payment.failed.is_pathfinding_timeout ? "pathfinding_timeout" :
                    payment.failed.is_route_not_found ? "route_not_found" :
                    payment.failed.is_insufficient_balance ? "insufficient_balance" : null,
                secret: payment.payment?.secret,
                feeMtokens: payment.payment!=null ? new BN(payment.payment.fee_mtokens) : undefined,
            }
        } catch (e) {
            if (Array.isArray(e) && e[0] === 404 && e[1] === "SentPaymentNotFound") return null;
            throw e;
        }
    }

    waitForPayment(paymentHash: string, abortSignal?: AbortSignal): Promise<OutgoingLightningNetworkPayment> {
        const subscription = subscribeToPastPayment({id: paymentHash, lnd: this.lnd});

        return new Promise<OutgoingLightningNetworkPayment>((resolve, reject) => {
            if(abortSignal!=null) {
                abortSignal.throwIfAborted();
                abortSignal.addEventListener("abort", () => {
                    subscription.removeAllListeners();
                    reject(abortSignal.reason);
                })
            }
            subscription.on('confirmed', (payment) => {
                resolve({
                    status: "confirmed",
                    feeMtokens: new BN(payment.fee_mtokens),
                    secret: payment.secret
                });
                subscription.removeAllListeners();
            });
            subscription.on('failed', (data) => {
                resolve({
                    status: "failed",
                    failedReason: data.is_invalid_payment ? "invalid_payment" :
                        data.is_pathfinding_timeout ? "pathfinding_timeout" :
                        data.is_route_not_found ? "route_not_found" :
                        data.is_insufficient_balance ? "insufficient_balance" : null,
                });
                subscription.removeAllListeners();
            });
        });
    }

    async pay(init: LightningPaymentInit): Promise<void> {
        await pay({
            request: init.request,
            max_fee_mtokens: init.maxFeeMtokens.toString(10),
            max_timeout_height: init.maxTimeoutHeight,
            lnd: this.lnd
        });
    }

    async getLightningBalance(): Promise<LightningBalanceResponse> {
        const resp = await getChannelBalance({lnd: this.lnd});
        return {
            localBalance: new BN(resp.channel_balance),
            remoteBalance: new BN(resp.inbound),
            unsettledBalance: new BN(resp.unsettled_balance)
        };
    }

    async probe(init: ProbeAndRouteInit): Promise<ProbeAndRouteResponse | null> {
        const parsedRequest = parsePaymentRequest({
            request: init.request
        });
        try {
            const result = await probeForRoute({
                mtokens: init.amountMtokens.toString(10),
                total_mtokens: init.amountMtokens.toString(10),
                max_fee_mtokens: init.maxFeeMtokens.toString(10),
                max_timeout_height: init.maxTimeoutHeight,
                payment: parsedRequest.payment,
                destination: parsedRequest.destination,
                cltv_delta: parsedRequest.cltv_delta,
                routes: parsedRequest.routes,
                lnd: this.lnd
            });
            if(result.route==null) return null;
            return {
                confidence: result.route.confidence,
                feeMtokens: new BN(result.route.fee_mtokens)
            }
        } catch (e) {
            //TODO: Properly handle error, such that only routing failed error is consumed, and e.g. network errors are thrown
            return null;
        }
    }

    async route(init: ProbeAndRouteInit): Promise<ProbeAndRouteResponse | null> {
        const parsedRequest = parsePaymentRequest({
            request: init.request
        });
        try {
            const result = await getRouteToDestination({
                mtokens: init.amountMtokens.toString(10),
                total_mtokens: init.amountMtokens.toString(10),
                max_fee_mtokens: init.maxFeeMtokens.toString(10),
                max_timeout_height: init.maxTimeoutHeight,
                payment: parsedRequest.payment,
                destination: parsedRequest.destination,
                cltv_delta: parsedRequest.cltv_delta,
                routes: parsedRequest.routes,
                lnd: this.lnd
            });
            if(result.route==null) return null;
            return {
                confidence: result.route.confidence,
                feeMtokens: new BN(result.route.fee_mtokens)
            }
        } catch (e) {
            //TODO: Properly handle error, such that only routing failed error is consumed, and e.g. network errors are thrown
            return null;
        }
    }

}