import { CaptchaSolver } from "@/typings/index.js";
import axios, { AxiosInstance } from "axios";

// --- Type Definitions ---
type CaptchaTask = 
    | { type: "ImageToTextTaskMuggle" | "ImageToTextTaskM1"; body: string }
    | { type: "HCaptchaTaskProxyless"; websiteURL: string; websiteKey: string; userAgent?: string; isInvisible?: boolean; rqdata?: string };

interface BaseResponse {
    errorId: number;
    errorCode?: string;
    errorDescription?: string;
}

interface CreateTaskResponse extends BaseResponse {
    taskId: string;
}

interface GetTaskResultResponse extends BaseResponse {
    status: "ready" | "processing";
    solution?: any;
}

interface HCaptchaSolution {
    gRecaptchaResponse: string;
    userAgent: string;
    respKey?: string;
}

interface ImageSolution {
    text: string;
}

// --- Custom Error ---
class YesCaptchaError extends Error {
    constructor(public errorId: number, message: string, public errorCode?: string) {
        super(`[YesCaptcha Error ${errorId}] ${errorCode || ''}: ${message}`);
        this.name = "YesCaptchaError";
    }
}

// --- Options Interface ---
interface SolverOptions {
    clientKey: string;
    pollingInterval?: number; // Thời gian nghỉ giữa các lần check kết quả (ms)
    maxPollingRetries?: number; // Số lần check kết quả tối đa
    
    // Cấu hình mới cho việc tạo task (chống spam)
    createTaskMaxRetries?: number; // Số lần thử lại nếu tạo task thất bại
    createTaskDelay?: number;      // Thời gian chờ cơ bản khi tạo task lỗi (ms)
    
    debug?: boolean;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Class Implementation ---
export class YesCaptchaSolver implements CaptchaSolver {
    private axiosInstance: AxiosInstance;
    private options: Required<Omit<SolverOptions, 'clientKey'>>;
    private apiKey: string;

    constructor(options: SolverOptions | string) {
        // Xử lý options để tương thích ngược với code cũ
        if (typeof options === 'string') {
            this.apiKey = options;
            this.options = { 
                pollingInterval: 3000, 
                maxPollingRetries: 60, 
                createTaskMaxRetries: 3, // Mặc định thử lại 3 lần nếu tạo lỗi
                createTaskDelay: 3000,   // Mặc định chờ 3s trước khi thử lại
                debug: false 
            };
        } else {
            this.apiKey = options.clientKey;
            this.options = {
                pollingInterval: options.pollingInterval || 3000,
                maxPollingRetries: options.maxPollingRetries || 60,
                createTaskMaxRetries: options.createTaskMaxRetries || 3,
                createTaskDelay: options.createTaskDelay || 3000,
                debug: options.debug || false,
            };
        }

        this.axiosInstance = axios.create({
            baseURL: "https://api.yescaptcha.com",
            headers: { "User-Agent": "YesCaptcha-Node-Client/1.2-AntiSpam" },
            timeout: 15000, // Tăng timeout lên 15s
        });
    }

    private log(msg: string, data?: any) {
        if (this.options.debug) {
            console.log(`[YesCaptcha] ${msg}`, data || '');
        }
    }

    /**
     * Tạo task với cơ chế Retry thông minh để tránh bị khóa IP
     */
    private async createTask<T extends BaseResponse>(taskPayload: CaptchaTask): Promise<T> {
        let attempts = 0;
        let lastError: any;

        // Vòng lặp thử lại khi tạo task
        while (attempts <= this.options.createTaskMaxRetries) {
            try {
                if (attempts > 0) {
                    // Cơ chế Backoff: Lần 1 chờ 3s, lần 2 chờ 6s, lần 3 chờ 9s...
                    // Giúp server thấy mình không spam dồn dập
                    const waitTime = this.options.createTaskDelay * attempts;
                    this.log(`Retry creating task... Attempt ${attempts}/${this.options.createTaskMaxRetries}. Waiting ${waitTime}ms`);
                    await delay(waitTime);
                }

                const { data } = await this.axiosInstance.post<T>("/createTask", {
                    clientKey: this.apiKey,
                    task: taskPayload,
                });

                // Nếu thành công (errorId = 0) -> Trả về ngay
                if (data.errorId === 0) {
                    return data;
                }

                // Nếu lỗi liên quan đến tài khoản (hết tiền, sai key) -> Không retry, throw luôn
                // (Giả sử errorId 1 là unknown, các số khác check document YesCaptcha nếu cần)
                // Ở đây ta log lỗi nhưng chưa throw để cho phép retry
                this.log(`Create task failed (API Error): ${data.errorDescription}`);
                lastError = new YesCaptchaError(data.errorId, data.errorDescription || "Unknown Error", data.errorCode);

            } catch (error: any) {
                // Lỗi mạng (Network Error, Timeout...)
                this.log(`Create task failed (Network): ${error.message}`);
                lastError = error;
            }

            attempts++;
        }

        // Nếu hết số lần thử mà vẫn lỗi
        throw lastError || new Error("Failed to create task after multiple attempts");
    }

    private async pollTaskResult<T>(taskId: string): Promise<T> {
        let attempts = 0;
        
        while (attempts < this.options.maxPollingRetries) {
            attempts++;
            await delay(this.options.pollingInterval);

            try {
                const { data } = await this.axiosInstance.post<GetTaskResultResponse>("/getTaskResult", {
                    clientKey: this.apiKey,
                    taskId: taskId,
                });

                if (data.errorId !== 0) {
                     // Nếu đang poll mà gặp lỗi API -> throw luôn để dừng task này lại
                     throw new YesCaptchaError(data.errorId, data.errorDescription || "Polling Error", data.errorCode);
                }

                if (data.status === "ready") {
                    this.log(`Task ${taskId} solved.`);
                    return data.solution as T;
                }
                
                // Vẫn đang processing...
            } catch (error: any) {
                if (error instanceof YesCaptchaError) throw error;
                // Nếu lỗi mạng khi poll, bỏ qua và chờ lần poll tiếp theo
                this.log(`Network glitch polling task ${taskId}, retrying...`);
            }
        }

        throw new Error(`[YesCaptcha] Timeout: Task ${taskId} did not complete.`);
    }

    public async solveImage(imageData: Buffer): Promise<string> {
        const response = await this.createTask<{ errorId: number; solution: ImageSolution; errorDescription?: string }>({
            type: "ImageToTextTaskM1", 
            body: imageData.toString("base64"),
        });
        return response.solution.text;
    }

    public async solveHcaptcha(sitekey: string, siteurl: string): Promise<string> {
        this.log(`Starting HCaptcha: ${siteurl}`);
        
        // Bước 1: Create Task (đã bao gồm tự động retry nếu fail)
        const createResponse = await this.createTask<CreateTaskResponse>({
            type: "HCaptchaTaskProxyless",
            websiteKey: sitekey,
            websiteURL: siteurl,
        });

        this.log(`Task created ID: ${createResponse.taskId}`);

        // Bước 2: Lấy kết quả
        const solution = await this.pollTaskResult<HCaptchaSolution>(createResponse.taskId);
        return solution.gRecaptchaResponse;
    }
}
