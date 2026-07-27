const capitals = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 把数字转成中文大写，只用于日志里的可读计数 */
export const number2capital = (number: number) => {
    return String(number).split('').map(i => capitals[Number(i)]).join('');
};
