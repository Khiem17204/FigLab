import {
  createTiffWorkerHandler,
  type TiffWorkerRequest,
  type TiffWorkerResponse,
} from "@figlab/image-processing";

const handler = createTiffWorkerHandler();
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<TiffWorkerRequest>) => void) | null;
  postMessage(message: TiffWorkerResponse, transfer: Transferable[]): void;
};

scope.onmessage = (event) => {
  void handler.handle(event.data).then(({ response, transfer }) => {
    scope.postMessage(response, transfer);
  });
};
