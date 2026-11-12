/** HTTP ステータス付きのエラー。ルーティング層で JSON に変換する。 */
export class HttpError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
    }
}
