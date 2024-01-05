
export interface IBtcFeeEstimator {

    //Returns estimated fee in sats/vB
    estimateFee(): Promise<number | null>;

}