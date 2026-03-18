const { FileSources } = require('librechat-data-provider');
const {
  uploadMistralOCR,
  uploadAzureMistralOCR,
  uploadGoogleVertexMistralOCR,
} = require('@librechat/api');
const {
  getFirebaseURL,
  prepareImageURL,
  saveURLToFirebase,
  deleteFirebaseFile,
  saveBufferToFirebase,
  uploadFileToFirebase,
  uploadImageToFirebase,
  processFirebaseAvatar,
  getFirebaseFileStream,
} = require('./Firebase');
const {
  uploadLocalFile,
  getLocalFileURL,
  saveFileFromURL,
  saveLocalBuffer,
  deleteLocalFile,
  getLocalFileStream,
} = require('./Local');
const {
  uploadLocalImage,
  prepareImagesLocal,
  processLocalAvatar,
} = require('./Local/images');
const {
  getS3URL,
  saveURLToS3,
  saveBufferToS3,
  getS3FileStream,
  uploadImageToS3,
  prepareImageURLS3,
  deleteFileFromS3,
  processS3Avatar,
  uploadFileToS3,
} = require('./S3');
const {
  saveBufferToAzure,
  saveURLToAzure,
  getAzureURL,
  deleteFileFromAzure,
  uploadFileToAzure,
  getAzureFileStream,
  uploadImageToAzure,
  prepareAzureImageURL,
  processAzureAvatar,
} = require('./Azure');
const { uploadOpenAIFile, deleteOpenAIFile, getOpenAIFileStream } = require('./OpenAI');
const { getCodeOutputDownloadStream, uploadCodeEnvFile } = require('./Code');
const { uploadVectors, deleteVectors } = require('./VectorDB');

/**
 * Firebase Storage Strategy Functions
 * 
 * Wrappers extract tenantId from req and pass explicitly to Firebase CRUD functions (clean-slate boundary discipline)
 */
const firebaseStrategy = () => ({
  handleFileUpload: (params) => {
    const tenantId = params.req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for Firebase file upload. Ensure requireTenantContext middleware runs.');
    }
    return uploadFileToFirebase({
      tenantId,
      userId: params.req.user.id,
      file: params.file,
      file_id: params.file_id,
    });
  },
  saveURL: (params) => {
    const tenantId = params.req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for Firebase saveURL. Ensure requireTenantContext middleware runs.');
    }
    return saveURLToFirebase({
      tenantId,
      userId: params.userId || params.req.user.id,
      URL: params.URL,
      fileName: params.fileName,
      basePath: params.basePath,
    });
  },
  getFileURL: (params) => {
    const tenantId = params.req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for Firebase getFileURL. Ensure requireTenantContext middleware runs.');
    }
    return getFirebaseURL({
      tenantId,
      userId: params.userId || params.req.user.id,
      fileName: params.fileName,
      basePath: params.basePath,
    });
  },
  deleteFile: (req, file) => {
    const tenantId = req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for Firebase delete. Ensure requireTenantContext middleware runs.');
    }
    // Extract file metadata from file object
    const basePath = file.context === 'documents' ? 'documents' : (file.filepath?.includes('/uploads/') ? 'uploads' : 'images');
    
    // Extract explicit parameters for RAG cleanup (if needed)
    let ragJwtToken = null;
    if (file.embedded && file.file_id) {
      const { generateShortLivedToken } = require('@librechat/api');
      ragJwtToken = generateShortLivedToken(file.user || req.user.id);
    }
    
    return deleteFirebaseFile({
      tenantId,
      userId: file.user || req.user.id,
      basePath,
      fileName: file.filename || file.filepath?.split('/').pop() || '',
      embedded: file.embedded,
      ragFileId: file.file_id,
      ragJwtToken,
      ragApiUrl: process.env.RAG_API_URL,
    });
  },
  saveBuffer: (params) => {
    const tenantId = params.req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for Firebase saveBuffer. Ensure requireTenantContext middleware runs.');
    }
    return saveBufferToFirebase({
      tenantId,
      userId: params.userId || params.req.user.id,
      buffer: params.buffer,
      fileName: params.fileName,
      basePath: params.basePath,
    });
  },
  prepareImagePayload: prepareImageURL,
  processAvatar: (params) => {
    const tenantId = params.req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for Firebase avatar processing. Ensure requireTenantContext middleware runs.');
    }
    return processFirebaseAvatar({
      tenantId,
      buffer: params.buffer,
      userId: params.userId,
      manual: params.manual,
      agentId: params.agentId,
    });
  },
  handleImageUpload: (params) => {
    const tenantId = params.req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for Firebase image upload. Ensure requireTenantContext middleware runs.');
    }
    return uploadImageToFirebase({
      tenantId,
      userId: params.req.user.id,
      file: params.file,
      file_id: params.file_id,
      endpoint: params.endpoint,
      resolution: params.resolution,
      appConfig: params.req.config,
    });
  },
  getDownloadStream: (req, filePathOrFile) => {
    const tenantId = req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for Firebase stream. Ensure requireTenantContext middleware runs.');
    }
    // If filePathOrFile is a file object with metadata, use it
    if (typeof filePathOrFile === 'object' && filePathOrFile.user && filePathOrFile.filename) {
      const basePath = filePathOrFile.context === 'documents' ? 'documents' : (filePathOrFile.filepath?.includes('/uploads/') ? 'uploads' : 'images');
      return getFirebaseFileStream({
        tenantId,
        userId: filePathOrFile.user,
        basePath,
        fileName: filePathOrFile.filename,
      });
    }
    // Fallback: try to extract from file object if available in req context
    throw new Error('getFirebaseFileStream requires file object with user, filename, context. Cannot use filepath string alone.');
  },
});

/**
 * Local Server Storage Strategy Functions
 * 
 * Wrappers extract tenantId from req and pass explicitly to Local CRUD functions (clean-slate boundary discipline)
 */
const localStrategy = () => ({
  handleFileUpload: (params) => {
    const tenantId = params.req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for local file upload. Ensure requireTenantContext middleware runs.');
    }
    return uploadLocalFile({
      tenantId,
      userId: params.req.user.id,
      file: params.file,
      file_id: params.file_id,
      appConfig: params.req.config,
    });
  },
  saveURL: (params) => {
    const tenantId = params.req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for local saveURL. Ensure requireTenantContext middleware runs.');
    }
    return saveFileFromURL({
      tenantId,
      userId: params.userId || params.req.user.id,
      URL: params.URL,
      fileName: params.fileName,
      basePath: params.basePath,
      appConfig: params.req?.config,
    });
  },
  getFileURL: (params) => {
    const tenantId = params.req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for local getFileURL. Ensure requireTenantContext middleware runs.');
    }
    return getLocalFileURL({
      tenantId,
      userId: params.userId || params.req.user.id,
      fileName: params.fileName,
      basePath: params.basePath,
      appConfig: params.req?.config,
    });
  },
  deleteFile: (req, file) => {
    const tenantId = req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for local delete. Ensure requireTenantContext middleware runs.');
    }
    const basePath = file.context === 'documents' ? 'documents' : (file.filepath?.includes('/uploads/') ? 'uploads' : 'images');
    
    // Extract explicit parameters for RAG cleanup (if needed)
    let ragJwtToken = null;
    if (file.embedded && file.file_id) {
      const { generateShortLivedToken } = require('@librechat/api');
      ragJwtToken = generateShortLivedToken(file.user || req.user.id);
    }
    
    return deleteLocalFile({
      tenantId,
      userId: file.user || req.user.id,
      basePath,
      fileName: file.filename || file.filepath?.split('/').pop() || '',
      appConfig: req.config,
      embedded: file.embedded,
      ragFileId: file.file_id,
      ragJwtToken,
      ragApiUrl: process.env.RAG_API_URL,
    });
  },
  saveBuffer: (params) => {
    const tenantId = params.req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for local saveBuffer. Ensure requireTenantContext middleware runs.');
    }
    return saveLocalBuffer({
      tenantId,
      userId: params.userId || params.req.user.id,
      buffer: params.buffer,
      fileName: params.fileName,
      basePath: params.basePath,
      appConfig: params.req?.config,
    });
  },
  processAvatar: (params) => {
    const tenantId = params.req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for local avatar processing. Ensure requireTenantContext middleware runs.');
    }
    return processLocalAvatar({
      tenantId,
      buffer: params.buffer,
      userId: params.userId,
      manual: params.manual,
      agentId: params.agentId,
      appConfig: params.req?.config,
    });
  },
  handleImageUpload: (params) => {
    const tenantId = params.req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for local image upload. Ensure requireTenantContext middleware runs.');
    }
    return uploadLocalImage({
      tenantId,
      userId: params.req.user.id,
      file: params.file,
      file_id: params.file_id,
      endpoint: params.endpoint,
      resolution: params.resolution,
      basePath: params.basePath,
      appConfig: params.req.config,
    });
  },
  prepareImagePayload: prepareImagesLocal,
  getDownloadStream: (req, filePathOrFile) => {
    const tenantId = req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for local stream. Ensure requireTenantContext middleware runs.');
    }
    if (typeof filePathOrFile === 'object' && filePathOrFile.user && filePathOrFile.filename) {
      const basePath = filePathOrFile.context === 'documents' ? 'documents' : (filePathOrFile.filepath?.includes('/uploads/') ? 'uploads' : 'images');
      return getLocalFileStream({
        tenantId,
        userId: filePathOrFile.user,
        basePath,
        fileName: filePathOrFile.filename,
        appConfig: req.config,
      });
    }
    throw new Error('getLocalFileStream requires file object with user, filename, context. Cannot use filepath string alone.');
  },
});

/**
 * S3 Storage Strategy Functions
 * 
 * Wrappers extract tenantId from req and pass explicitly to S3 CRUD functions (clean-slate boundary discipline)
 */
const s3Strategy = () => ({
  handleFileUpload: (params) => {
    const tenantId = params.req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for S3 upload. Ensure requireTenantContext middleware runs.');
    }
    return uploadFileToS3({
      tenantId,
      userId: params.req.user.id,
      file: params.file,
      file_id: params.file_id,
      basePath: params.basePath,
    });
  },
  saveURL: saveURLToS3,
  getFileURL: getS3URL,
  deleteFile: (req, file) => {
    const tenantId = req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for S3 delete. Ensure requireTenantContext middleware runs.');
    }
    // Extract file metadata from file object
    // File objects should have user, filename, and context/basePath
    const basePath = file.context === 'documents' ? 'documents' : 'images';
    return deleteFileFromS3({
      tenantId,
      userId: file.user || req.user.id,
      basePath,
      fileName: file.filename || file.filepath.split('/').pop(),
    });
  },
  saveBuffer: saveBufferToS3,
  prepareImagePayload: prepareImageURLS3,
  processAvatar: processS3Avatar,
  handleImageUpload: (params) => {
    const tenantId = params.req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for S3 image upload. Ensure requireTenantContext middleware runs.');
    }
    return uploadImageToS3({
      tenantId,
      userId: params.req.user.id,
      file: params.file,
      file_id: params.file_id,
      endpoint: params.endpoint,
      resolution: params.resolution,
      basePath: params.basePath,
      appConfig: params.req.config,
    });
  },
  getDownloadStream: (req, filePathOrFile) => {
    const tenantId = req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for S3 stream. Ensure requireTenantContext middleware runs.');
    }
    // If filePathOrFile is a file object with metadata, use it
    // Otherwise, if it's a string (filepath), we need file metadata from req context
    // For S3, we require file object with user, filename, context
    if (typeof filePathOrFile === 'object' && filePathOrFile.user && filePathOrFile.filename) {
      const basePath = filePathOrFile.context === 'documents' ? 'documents' : 'images';
      return getS3FileStream({
        tenantId,
        userId: filePathOrFile.user,
        basePath,
        fileName: filePathOrFile.filename,
      });
    }
    // Fallback: try to extract from file object if available in req context
    // This is a limitation - ideally file object should be passed
    throw new Error('getS3FileStream requires file object with user, filename, context. Cannot use filepath string alone.');
  },
});

/**
 * Azure Blob Storage Strategy Functions
 * 
 * Wrappers extract tenantId from req and pass explicitly to Azure CRUD functions (clean-slate boundary discipline)
 */
const azureStrategy = () => ({
  handleFileUpload: (params) => {
    const tenantId = params.req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for Azure upload. Ensure requireTenantContext middleware runs.');
    }
    return uploadFileToAzure({
      tenantId,
      userId: params.req.user.id,
      file: params.file,
      file_id: params.file_id,
      basePath: params.basePath,
    });
  },
  saveURL: (params) => {
    const tenantId = params.req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for Azure saveURL. Ensure requireTenantContext middleware runs.');
    }
    return saveURLToAzure({
      tenantId,
      userId: params.userId || params.req.user.id,
      URL: params.URL,
      fileName: params.fileName,
      basePath: params.basePath,
    });
  },
  getFileURL: (params) => {
    const tenantId = params.req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for Azure getFileURL. Ensure requireTenantContext middleware runs.');
    }
    return getAzureURL({
      tenantId,
      userId: params.userId || params.req.user.id,
      fileName: params.fileName,
      basePath: params.basePath,
    });
  },
  deleteFile: (req, file) => {
    const tenantId = req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for Azure delete. Ensure requireTenantContext middleware runs.');
    }
    // Extract file metadata from file object
    const basePath = file.context === 'documents' ? 'documents' : (file.filepath?.includes('/uploads/') ? 'uploads' : 'images');
    
    return deleteFileFromAzure({
      tenantId,
      userId: file.user || req.user.id,
      basePath,
      fileName: file.filename || file.filepath?.split('/').pop() || '',
    });
  },
  saveBuffer: (params) => {
    const tenantId = params.req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for Azure saveBuffer. Ensure requireTenantContext middleware runs.');
    }
    return saveBufferToAzure({
      tenantId,
      userId: params.userId || params.req.user.id,
      buffer: params.buffer,
      fileName: params.fileName,
      basePath: params.basePath,
    });
  },
  prepareImagePayload: prepareAzureImageURL,
  processAvatar: (params) => {
    const tenantId = params.req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for Azure avatar processing. Ensure requireTenantContext middleware runs.');
    }
    return processAzureAvatar({
      tenantId,
      buffer: params.buffer,
      userId: params.userId,
      manual: params.manual,
      agentId: params.agentId,
      basePath: params.basePath,
    });
  },
  handleImageUpload: (params) => {
    const tenantId = params.req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for Azure image upload. Ensure requireTenantContext middleware runs.');
    }
    return uploadImageToAzure({
      tenantId,
      userId: params.req.user.id,
      file: params.file,
      file_id: params.file_id,
      endpoint: params.endpoint,
      resolution: params.resolution,
      basePath: params.basePath,
      appConfig: params.req.config,
    });
  },
  getDownloadStream: (req, filePathOrFile) => {
    const tenantId = req?.tenantContext?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant ID required for Azure stream. Ensure requireTenantContext middleware runs.');
    }
    // If filePathOrFile is a file object with metadata, use it
    if (typeof filePathOrFile === 'object' && filePathOrFile.user && filePathOrFile.filename) {
      const basePath = filePathOrFile.context === 'documents' ? 'documents' : (filePathOrFile.filepath?.includes('/uploads/') ? 'uploads' : 'images');
      return getAzureFileStream({
        tenantId,
        userId: filePathOrFile.user,
        basePath,
        fileName: filePathOrFile.filename,
      });
    }
    throw new Error('getAzureFileStream requires file object with user, filename, context. Cannot use filepath string alone.');
  },
});

/**
 * VectorDB Storage Strategy Functions
 *
 * */
const vectorStrategy = () => ({
  /** @type {typeof saveFileFromURL | null} */
  saveURL: null,
  /** @type {typeof getLocalFileURL | null} */
  getFileURL: null,
  /** @type {typeof saveLocalBuffer | null} */
  saveBuffer: null,
  /** @type {typeof processLocalAvatar | null} */
  processAvatar: null,
  /** @type {typeof uploadLocalImage | null} */
  handleImageUpload: null,
  /** @type {typeof prepareImagesLocal | null} */
  prepareImagePayload: null,
  /** @type {typeof getLocalFileStream | null} */
  getDownloadStream: null,
  handleFileUpload: uploadVectors,
  deleteFile: deleteVectors,
});

/**
 * OpenAI Strategy Functions
 *
 * Note: null values mean that the strategy is not supported.
 * */
const openAIStrategy = () => ({
  /** @type {typeof saveFileFromURL | null} */
  saveURL: null,
  /** @type {typeof getLocalFileURL | null} */
  getFileURL: null,
  /** @type {typeof saveLocalBuffer | null} */
  saveBuffer: null,
  /** @type {typeof processLocalAvatar | null} */
  processAvatar: null,
  /** @type {typeof uploadLocalImage | null} */
  handleImageUpload: null,
  /** @type {typeof prepareImagesLocal | null} */
  prepareImagePayload: null,
  deleteFile: deleteOpenAIFile,
  handleFileUpload: uploadOpenAIFile,
  getDownloadStream: getOpenAIFileStream,
});

/**
 * Code Output Strategy Functions
 *
 * Note: null values mean that the strategy is not supported.
 * */
const codeOutputStrategy = () => ({
  /** @type {typeof saveFileFromURL | null} */
  saveURL: null,
  /** @type {typeof getLocalFileURL | null} */
  getFileURL: null,
  /** @type {typeof saveLocalBuffer | null} */
  saveBuffer: null,
  /** @type {typeof processLocalAvatar | null} */
  processAvatar: null,
  /** @type {typeof uploadLocalImage | null} */
  handleImageUpload: null,
  /** @type {typeof prepareImagesLocal | null} */
  prepareImagePayload: null,
  /** @type {typeof deleteLocalFile | null} */
  deleteFile: null,
  handleFileUpload: uploadCodeEnvFile,
  getDownloadStream: getCodeOutputDownloadStream,
});

const mistralOCRStrategy = () => ({
  /** @type {typeof saveFileFromURL | null} */
  saveURL: null,
  /** @type {typeof getLocalFileURL | null} */
  getFileURL: null,
  /** @type {typeof saveLocalBuffer | null} */
  saveBuffer: null,
  /** @type {typeof processLocalAvatar | null} */
  processAvatar: null,
  /** @type {typeof uploadLocalImage | null} */
  handleImageUpload: null,
  /** @type {typeof prepareImagesLocal | null} */
  prepareImagePayload: null,
  /** @type {typeof deleteLocalFile | null} */
  deleteFile: null,
  /** @type {typeof getLocalFileStream | null} */
  getDownloadStream: null,
  handleFileUpload: uploadMistralOCR,
});

const azureMistralOCRStrategy = () => ({
  /** @type {typeof saveFileFromURL | null} */
  saveURL: null,
  /** @type {typeof getLocalFileURL | null} */
  getFileURL: null,
  /** @type {typeof saveLocalBuffer | null} */
  saveBuffer: null,
  /** @type {typeof processLocalAvatar | null} */
  processAvatar: null,
  /** @type {typeof uploadLocalImage | null} */
  handleImageUpload: null,
  /** @type {typeof prepareImagesLocal | null} */
  prepareImagePayload: null,
  /** @type {typeof deleteLocalFile | null} */
  deleteFile: null,
  /** @type {typeof getLocalFileStream | null} */
  getDownloadStream: null,
  handleFileUpload: uploadAzureMistralOCR,
});

const vertexMistralOCRStrategy = () => ({
  /** @type {typeof saveFileFromURL | null} */
  saveURL: null,
  /** @type {typeof getLocalFileURL | null} */
  getFileURL: null,
  /** @type {typeof saveLocalBuffer | null} */
  saveBuffer: null,
  /** @type {typeof processLocalAvatar | null} */
  processAvatar: null,
  /** @type {typeof uploadLocalImage | null} */
  handleImageUpload: null,
  /** @type {typeof prepareImagesLocal | null} */
  prepareImagePayload: null,
  /** @type {typeof deleteLocalFile | null} */
  deleteFile: null,
  /** @type {typeof getLocalFileStream | null} */
  getDownloadStream: null,
  handleFileUpload: uploadGoogleVertexMistralOCR,
});

// Strategy Selector
const getStrategyFunctions = (fileSource) => {
  if (fileSource === FileSources.firebase) {
    return firebaseStrategy();
  } else if (fileSource === FileSources.local) {
    return localStrategy();
  } else if (fileSource === FileSources.openai) {
    return openAIStrategy();
  } else if (fileSource === FileSources.azure) {
    return openAIStrategy();
  } else if (fileSource === FileSources.azure_blob) {
    return azureStrategy();
  } else if (fileSource === FileSources.vectordb) {
    return vectorStrategy();
  } else if (fileSource === FileSources.s3) {
    return s3Strategy();
  } else if (fileSource === FileSources.execute_code) {
    return codeOutputStrategy();
  } else if (fileSource === FileSources.mistral_ocr) {
    return mistralOCRStrategy();
  } else if (fileSource === FileSources.azure_mistral_ocr) {
    return azureMistralOCRStrategy();
  } else if (fileSource === FileSources.vertexai_mistral_ocr) {
    return vertexMistralOCRStrategy();
  } else if (fileSource === FileSources.text) {
    return localStrategy(); // Text files use local strategy
  } else {
    throw new Error(
      `Invalid file source: ${fileSource}. Available sources: ${Object.values(FileSources).join(', ')}`,
    );
  }
};

module.exports = {
  getStrategyFunctions,
};
