import {Express} from "express";
import {MultichainData, SwapHandler, SwapHandlerInfoType, SwapHandlerType} from "../swaps/SwapHandler";
import * as express from "express";

const HEX_REGEX = /[0-9a-f]+/i;

type InfoHandlerResponseEnvelope = {
    nonce: string,
    services: {
        [key in SwapHandlerType]?: SwapHandlerInfoType
    }
};

type InfoHandlerResponse = {
    envelope: string,
    address: string,
    signature: string,
    chains: {
        [chainIdentifier: string]: {
            address: string,
            signature: string
        }
    }
}

/**
 * Handles info requests to POST /info returning information about fees, swap params, etc.
 */
export class InfoHandler {

    readonly chainData: MultichainData;
    readonly path: string;

    readonly swapHandlers: SwapHandler[];

    constructor(chainData: MultichainData, path: string, swapHandlers: SwapHandler[]) {
        this.chainData = chainData;
        this.path = path;
        this.swapHandlers = swapHandlers;
    }

    /**
     * Adds a listener to POST /info
     *
     * @param restServer
     */
    startRestServer(restServer: Express) {

        restServer.use(this.path+"/info", express.json());
        restServer.post(this.path+"/info", async (req, res) => {
            if (
                req.body == null ||

                req.body.nonce == null ||
                typeof(req.body.nonce) !== "string" ||
                req.body.nonce.length>64 ||
                !HEX_REGEX.test(req.body.nonce)
            ) {
                res.status(400).json({
                    msg: "Invalid request body (nonce)"
                });
                return;
            }

            const env: InfoHandlerResponseEnvelope = {
                nonce: req.body.nonce,
                services: {}
            };

            for(let swapHandler of this.swapHandlers) {
                env.services[swapHandler.type] = swapHandler.getInfo();
            }

            const envelope = JSON.stringify(env);
            const envelopeBuffer = Buffer.from(envelope);

            const chains: {
                [chainIdentifier: string]: {
                    address: string,
                    signature: string
                }
            } = {};
            for(let chainIdentifier in this.chainData.chains) {
                const singleChain = this.chainData.chains[chainIdentifier];
                chains[chainIdentifier] = {
                    address: singleChain.signer.getAddress(),
                    signature: await singleChain.swapContract.getDataSignature(singleChain.signer, envelopeBuffer)
                };
            }

            const defaults = chains[this.chainData.default];

            const response: InfoHandlerResponse = {
                envelope,
                address: defaults.address,
                signature: defaults.signature,
                chains
            };

            res.status(200).json(response);
        });

    }


}
