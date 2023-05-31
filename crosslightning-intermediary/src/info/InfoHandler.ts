import {SwapContract, SwapData} from "crosslightning-base";
import {Express} from "express";
import {SwapHandler, SwapHandlerInfoType, SwapHandlerType} from "../swaps/SwapHandler";

const HEX_REGEX = /[0-9a-f]+/i;

type InfoHandlerResponseEnvelope = {
    nonce: string,
    services: {
        [key in SwapHandlerType]?: SwapHandlerInfoType
    }
};

type InfoHandlerResponse = {
    address: string,
    envelope: string,
    signature: string
}

/**
 * Handles info requests to POST /info returning information about fees, swap params, etc.
 */
export class InfoHandler<T extends SwapData> {

    readonly swapContract: SwapContract<T, any>;
    readonly path: string;

    readonly swapHandlers: SwapHandler<any, any>[];

    constructor(swapContract: SwapContract<T, any>, path: string, swapHandlers: SwapHandler<any, any>[]) {
        this.swapContract = swapContract;
        this.path = path;
        this.swapHandlers = swapHandlers;
    }

    /**
     * Adds a listener to POST /info
     *
     * @param restServer
     */
    startRestServer(restServer: Express) {

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

            const signature = await this.swapContract.getDataSignature(Buffer.from(envelope));

            const response: InfoHandlerResponse = {
                address: this.swapContract.getAddress(),
                envelope,
                signature
            };

            res.status(200).json(response);
        });

    }


}
