import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const LiquidityPoolModule = buildModule("LiquidityPoolModule", (m) => {
    const operator = m.getParameter("operator");
    const pool = m.contract("LiquidityPool", [operator]);

    return { pool };
});

export default LiquidityPoolModule;
