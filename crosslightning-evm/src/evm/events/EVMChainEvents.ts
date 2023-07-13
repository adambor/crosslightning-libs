import {EVMSwapData} from "../swaps/EVMSwapData";
import * as fs from "fs/promises";
import {ChainEvents, SwapEvent, EventListener, ClaimEvent, RefundEvent, InitializeEvent} from "crosslightning-base";
import {EVMSwapProgram} from "../swaps/EVMSwapProgram";
import {providers} from "ethers";
import {Log} from "@ethersproject/abstract-provider/lib";

const BLOCKHEIGHT_FILENAME = "/blockheight.txt";
const LOG_FETCH_INTERVAL = 5*1000;
const LOG_FETCH_LIMIT = 2500;

export class EVMChainEvents implements ChainEvents<EVMSwapData> {

    private readonly listeners: EventListener<EVMSwapData>[] = [];
    private readonly directory: string;
    private readonly provider: providers.Provider;
    private readonly evmSwapProgram: EVMSwapProgram;
    private readonly logFetchLimit: number;

    constructor(directory: string, provider: providers.Provider, evmSwapProgram: EVMSwapProgram, logFetchLimit?: number) {
        this.directory = directory;
        this.provider = provider;
        this.evmSwapProgram = evmSwapProgram;
        this.logFetchLimit = logFetchLimit || LOG_FETCH_LIMIT;
    }

    private async getLastHeight() {
        try {
            const txt = await fs.readFile(this.directory+BLOCKHEIGHT_FILENAME);
            return parseInt(txt.toString());
        } catch (e) {
            return null;
        }
    }

    private saveLastBlockheight(lastBlockheight: number): Promise<void> {
        return fs.writeFile(this.directory+BLOCKHEIGHT_FILENAME, lastBlockheight.toString());
    }

    private async processEvent(log: Log) {
        let parsedEvents: SwapEvent<EVMSwapData>[] = [];

        const event = this.evmSwapProgram.contractInterface.parseLog(log);

        console.log("EVM parsed event: ", event);

        if(event==null) return;

        if(event.name==="Claim") {
            parsedEvents.push(new ClaimEvent<EVMSwapData>(event.args.paymentHash.substring(2), event.args.secret.substring(2)));
        }
        if(event.name==="Refund") {
            parsedEvents.push(new RefundEvent<EVMSwapData>(event.args.paymentHash.substring(2)));
        }
        if(event.name==="Initialize") {
            const object = new EVMSwapData(event.args.data);
            object.txoHash = event.args.txoHash;

            parsedEvents.push(new InitializeEvent<EVMSwapData>(
                event.args.paymentHash.substring(2),
                event.args.txoHash.substring(2),
                0,
                object
            ));
        }

        for(let listener of this.listeners) {
            await listener(parsedEvents);
        }
    }

    private async checkEvents() {
        let lastBlock = await this.getLastHeight();

        const block = await this.provider.getBlock("latest");
        let latestBlock = block.number;

        if(lastBlock==null) {
            if(latestBlock!=null) {
                await this.saveLastBlockheight(latestBlock);
            }
            return;
        }

        do {
            let toBlock;
            if(latestBlock-lastBlock>this.logFetchLimit) {
                toBlock = lastBlock+this.logFetchLimit;
            } else {
                toBlock = latestBlock;
            }

            const fromBlock = lastBlock+1;

            if(fromBlock>toBlock) {
                return;
            }

            const logs: Array<Log> = await this.provider.getLogs({
                fromBlock,
                toBlock,
                address: this.evmSwapProgram.contract.address
            });

            console.log("Returned past logs ("+fromBlock+"-"+toBlock+"): ", logs);

            //Check the logs
            for(let log of logs) {
                await this.processEvent(log);
            }

            lastBlock = toBlock;

            if(lastBlock!==latestBlock) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        } while(lastBlock!==latestBlock);

        await this.saveLastBlockheight(lastBlock);

    }

    async init(): Promise<void> {
        try {
            await fs.mkdir(this.directory);
        } catch (e) {}

        let func;
        func = async () => {
            await this.checkEvents().catch(e => {
                console.error("Failed to fetch Sol log");
                console.error(e);
            });
            setTimeout(func, LOG_FETCH_INTERVAL);
        };
        await func();
    }

    registerListener(cbk: EventListener<EVMSwapData>) {
        this.listeners.push(cbk);
    }

    unregisterListener(cbk: EventListener<EVMSwapData>): boolean {
        const index = this.listeners.indexOf(cbk);
        if(index>=0) {
            this.listeners.splice(index, 1);
            return true;
        }
        return false;
    }
}
