import * as BN from "bn.js";
import {ISwapPrice} from "../swaps/ISwapPrice";

const CACHE_DURATION = 15000;

export type CoinGeckoPriceData = {
    [coinId: string]: {
        [chainId: string]: {
            address: string,
            decimals: number
        }
    }
};

export class CoinGeckoSwapPrice extends ISwapPrice<{coinId: string, decimals: number}> {

    url: string;
    cache: {
        [coinId: string]: {
            price: BN,
            expiry: number
        }
    } = {};

    constructor(url: string, coins: CoinGeckoPriceData) {
        const coinsMap = {};
        for(let coinId in coins) {
            const chains = coins[coinId];
            for(let chainId in chains) {
                const tokenData = chains[chainId];
                if(coinsMap[chainId]==null) coinsMap[chainId] = {};
                coinsMap[chainId][tokenData.address] = {
                    coinId,
                    decimals: tokenData.decimals
                };
            }
        }
        super(coinsMap);
        this.url = url || "https://api.coingecko.com/api/v3";
    }

    /**
     * Returns coin price in mSat
     *
     * @param coin
     */
    async getPrice(coin: {coinId: string}): Promise<BN> {
        const coinId = coin.coinId;
        if(coinId.startsWith("$fixed-")) {
            const amt: number = parseFloat(coinId.substring(7));
            return new BN(Math.floor(amt*1000));
        }

        const cachedValue = this.cache[coinId];
        if(cachedValue!=null && cachedValue.expiry>Date.now()) {
            return cachedValue.price;
        }

        const response: Response = await fetch(this.url+"/simple/price?ids="+coinId+"&vs_currencies=sats&precision=3", {
            method: "GET",
            headers: {'Content-Type': 'application/json'}
        });

        if(response.status!==200) {
            let resp: string;
            try {
                resp = await response.text();
            } catch (e) {
                throw new Error(response.statusText);
            }
            throw new Error(resp);
        }

        let jsonBody: any = await response.json();

        const amt: number = jsonBody[coinId].sats;

        const result = new BN(amt*1000);

        this.cache[coinId] = {
            price: result,
            expiry: Date.now()+CACHE_DURATION
        };

        return result;
    }

}
