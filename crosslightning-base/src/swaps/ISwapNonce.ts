
export interface ISwapNonce {

    getNonce(token: string): number;
    getClaimNonce(token: string): number;

}