import { bytes } from 'k6'
import { parseHTML } from 'k6/html'
import http, { RefinedResponse, ResponseType } from 'k6/http'

import { AWSClient } from './client'
import { AWSConfig } from './config'
import { AWSError } from './error'
import { SignedHTTPRequest } from './http'
import { InvalidSignatureError, SignatureV4 } from './signature'

/** Class allowing to interact with Amazon AWS's S3 service */
export class S3Client extends AWSClient {
    signature: SignatureV4

    /**
     * Create a S3Client
     *
     * @param {AWSConfig} awsConfig - configuration attributes to use when interacting with AWS' APIs
     */
    constructor(awsConfig: AWSConfig) {
        super(awsConfig, 's3')

        this.signature = new SignatureV4({
            service: this.serviceName,
            region: this.awsConfig.region,
            credentials: {
                accessKeyId: this.awsConfig.accessKeyId,
                secretAccessKey: this.awsConfig.secretAccessKey,
                sessionToken: this.awsConfig.sessionToken,
            },
            uriEscapePath: false,
            applyChecksum: true,
        })
    }

    /**
     * Returns a list of all buckets owned by the authenticated sender of the request.
     * To use this operation, you must have the s3:ListAllMyBuckets permission.
     *
     * @return  {Array.<S3Bucket>} buckets - An array of objects describing S3 buckets
     *     with the following fields: name, and creationDate.
     * @throws  {S3ServiceError}
     * @throws  {InvalidSignatureError}
     */
    async listBuckets(): Promise<Array<S3Bucket>> {
        const method = 'GET'

        const signedRequest: SignedHTTPRequest = this.signature.sign(
            {
                method: 'GET',
                protocol: this.scheme,
                hostname: this.host,
                path: '/',
                headers: {},
            },
            {}
        )

        const res = await http.asyncRequest(method, signedRequest.url, signedRequest.body || '', {
            headers: signedRequest.headers,
        })
        this._handle_error('ListBuckets', res)

        let buckets: Array<S3Bucket> = []

        const doc = parseHTML(res.body as string)

        doc.find('Buckets')
            .children()
            .each((_, bucketDefinition) => {
                let bucket = {}

                bucketDefinition.children().forEach((child) => {
                    switch (child.nodeName()) {
                        case 'name':
                            Object.assign(bucket, { name: child.textContent() })
                            break
                        case 'creationdate':
                            Object.assign(bucket, {
                                creationDate: Date.parse(child.textContent()),
                            })
                    }
                })

                buckets.push(bucket as S3Bucket)
            })

        return buckets
    }

    /**
     * Returns some or all (up to 1,000) of the objects in a bucket.
     *
     * @param  {string} bucketName - Bucket name to list.
     * @param  {string?} prefix='' - Limits the response to keys that begin with the specified prefix.
     * @return {Array.<S3Object>} - returns an array of objects describing S3 objects
     *     with the following fields: key, lastModified, etag, size and storageClass.
     * @throws  {S3ServiceError}
     * @throws  {InvalidSignatureError}
     */
    async listObjects(bucketName: string, prefix?: string): Promise<Array<S3Object>> {
        // Prepare request
        const method = 'GET'
        const host = `${this.host}`

        const signedRequest: SignedHTTPRequest = this.signature.sign(
            {
                method: 'GET',
                protocol: this.scheme,
                hostname: host,
                path: `/${bucketName}/`,
                query: {
                    'list-type': '2',
                    prefix: prefix || '',
                },
                headers: {},
            },
            {}
        )

        const res = await http.asyncRequest(method, signedRequest.url, signedRequest.body || '', {
            headers: signedRequest.headers,
        })
        this._handle_error('ListObjectsV2', res)

        let objects: Array<S3Object> = []

        // Extract the objects definition from
        // the XML response
        parseHTML(res.body as string)
            .find('Contents')
            .each((_, objectDefinition) => {
                let obj = {}

                objectDefinition.children().forEach((child) => {
                    switch (child.nodeName()) {
                        case 'key':
                            Object.assign(obj, { key: child.textContent() })
                            break
                        case 'lastmodified':
                            Object.assign(obj, { lastModified: Date.parse(child.textContent()) })
                            break
                        case 'etag':
                            Object.assign(obj, { etag: child.textContent() })
                            break
                        case 'size':
                            Object.assign(obj, { size: parseInt(child.textContent()) })
                            break
                        case 'storageclass':
                            Object.assign(obj, { storageClass: child.textContent() })
                    }
                })

                objects.push(obj as S3Object)
            })

        return objects
    }
    /**
     * Retrieves an Object from Amazon S3.
     *
     * To use getObject, you must have `READ` access to the object.
     *
     * @param  {string} bucketName - The bucket name containing the object.
     * @param  {string} objectKey - Key of the object to get.
     * @return {S3Object} - returns the content of the fetched S3 Object.
     * @throws  {S3ServiceError}
     * @throws  {InvalidSignatureError}
     */
    async getObject(bucketName: string, objectKey: string): Promise<S3Object> {
        // Prepare request
        const method = 'GET'
        const host = `${this.host}`

        const signedRequest = this.signature.sign(
            {
                method: 'GET',
                protocol: this.scheme,
                hostname: host,
                path: `/${bucketName}/${objectKey}`,
                headers: {},
            },
            {}
        )

        const res = await http.asyncRequest(method, signedRequest.url, signedRequest.body || '', {
            headers: signedRequest.headers,
        })
        this._handle_error('GetObject', res)

        return new S3Object(
            objectKey,
            Date.parse(res.headers['Last-Modified']),
            res.headers['ETag'],
            parseInt(res.headers['Content-Length']),

            // The X-Amz-Storage-Class header is only set if the storage class is
            // not the default 'STANDARD' one.
            (res.headers['X-Amz-Storage-Class'] ?? 'STANDARD') as StorageClass,

            res.body
        )
    }
    /**
     * Adds an object to a bucket.
     *
     * You must have WRITE permissions on a bucket to add an object to it.
     *
     * @param  {string} bucketName - The bucket name containing the object.
     * @param  {string} objectKey - Key of the object to put.
     * @param  {string | ArrayBuffer} data - the content of the S3 Object to upload.
     * @throws  {S3ServiceError}
     * @throws  {InvalidSignatureError}
     */
    async putObject(
        bucketName: string,
        objectKey: string,
        data: string | ArrayBuffer
    ): Promise<void> {
        // Prepare request
        const method = 'PUT'
        const host = `${this.host}`

        const signedRequest = this.signature.sign(
            {
                method: method,
                protocol: this.scheme,
                hostname: host,
                path: `/${bucketName}/${objectKey}`,
                headers: {
                    Host: host,
                },
                body: data,
            },
            {}
        )

        const res = await http.asyncRequest(method, signedRequest.url, signedRequest.body, {
            headers: signedRequest.headers,
        })
        this._handle_error('PutObject', res)
    }

    /**
     * Removes the null version (if there is one) of an object and inserts a delete marker,
     * which becomes the latest version of the object.
     *
     * @param  {string} bucketName - The bucket name containing the object.
     * @param  {string} objectKey - Key of the object to delete.
     * @throws  {S3ServiceError}
     * @throws  {InvalidSignatureError}
     */
    async deleteObject(bucketName: string, objectKey: string): Promise<void> {
        // Prepare request
        const method = 'DELETE'
        const host = `${this.host}`

        const signedRequest = this.signature.sign(
            {
                method: method,
                protocol: this.scheme,
                hostname: host,
                path: `/${bucketName}/${objectKey}`,
                headers: {},
            },
            {}
        )

        const res = await http.asyncRequest(method, signedRequest.url, signedRequest.body || '', {
            headers: signedRequest.headers,
        })
        this._handle_error('DeleteObject', res)
    }

    /**
     * Copies an object from one bucket to another
     *
     * @param  {string} sourceBucket - The source bucket name containing the object.
     * @param  {string} sourceKey - Key of the source object to copy.
     * @param  {string} destinationBucket - The destination bucket name containing the object.
     * @param  {string} destinationKey - Key of the destination object.
     * @throws  {S3ServiceError}
     * @throws  {InvalidSignatureError}
     */
    async copyObject(
        sourceBucket: string,
        sourceKey: string,
        destinationBucket: string,
        destinationKey: string
    ): Promise<void> {
        // Prepare request
        const method = 'PUT'
        const host = `${destinationBucket}.${this.host}`

        const signedRequest = this.signature.sign(
            {
                method: method,
                protocol: this.scheme,
                hostname: host,
                path: `/${destinationKey}`,
                headers: {
                    'x-amz-copy-source': `${sourceBucket}/${sourceKey}`,
                },
            },
            {}
        )

        const res = await http.asyncRequest(method, signedRequest.url, signedRequest.body || null, {
            headers: signedRequest.headers,
        })

        this._handle_error('CopyObject', res)
    }

    /**
     * Creates a new multipart upload for a given objectKey.
     * The uploadId returned can be used to upload parts to the object.
     *
     * @param  {string} bucketName - The bucket name containing the object.
     * @param  {string} objectKey - Key of the object to upload.
     * @return {S3MultipartUpload} - returns the uploadId of the newly created multipart upload.
     * @throws  {S3ServiceError}
     * @throws  {InvalidSignatureError}
     */
    async createMultipartUpload(bucketName: string, objectKey: string): Promise<S3MultipartUpload> {
        // Prepare request
        const method = 'POST'
        const host = `${bucketName}.${this.host}`

        const signedRequest = this.signature.sign(
            {
                method: method,
                protocol: this.scheme,
                hostname: host,
                path: `/${objectKey}`,
                headers: {},
                query: { uploads: '' },
            },
            {}
        )

        const res = await http.asyncRequest(method, signedRequest.url, signedRequest.body || '', {
            headers: signedRequest.headers,
        })
        this._handle_error('CreateMultipartUpload', res)

        return new S3MultipartUpload(
            objectKey,
            parseHTML(res.body as string)
                .find('UploadId')
                .text()
        )
    }

    /**
     * Uploads a part in a multipart upload.
     * @param {string} bucketName - The bucket name containing the object.
     * @param {string} objectKey - Key of the object to upload.
     * @param {string} uploadId - The uploadId of the multipart upload.
     * @param {number} partNumber - The part number of the part to upload.
     * @param {string | ArrayBuffer} data - The content of the part to upload.
     * @return {S3Part} - returns the ETag of the uploaded part.
     * @throws  {S3ServiceError}
     */
    async uploadPart(
        bucketName: string,
        objectKey: string,
        uploadId: string,
        partNumber: number,
        data: string | ArrayBuffer
    ): Promise<S3Part> {
        // Prepare request
        const method = 'PUT'
        const host = `${bucketName}.${this.host}`
        const signedRequest = this.signature.sign(
            {
                method: method,
                protocol: this.scheme,
                hostname: host,
                path: `/${objectKey}`,
                headers: {},
                body: data,
                query: {
                    partNumber: `${partNumber}`,
                    uploadId: `${uploadId}`,
                },
            },
            {}
        )

        const res = await http.asyncRequest(method, signedRequest.url, signedRequest.body || '', {
            headers: signedRequest.headers,
        })
        this._handle_error('UploadPart', res)

        return new S3Part(partNumber, res.headers['Etag'])
    }

    /**
     * Completes a multipart upload by assembling previously uploaded parts.
     *
     * @param  {string} bucketName - The bucket name containing the object.
     * @param  {string} objectKey - Key of the object to delete.
     * @param  {string} uploadId - The uploadId of the multipart upload to complete.
     * @param  {S3Part[]} parts - The parts to assemble.
     * @throws  {S3ServiceError}
     * @throws  {InvalidSignatureError}
     */
    async completeMultipartUpload(
        bucketName: string,
        objectKey: string,
        uploadId: string,
        parts: S3Part[]
    ) {
        // Prepare request
        const method = 'POST'
        const host = `${bucketName}.${this.host}`
        const body = `<CompleteMultipartUpload>${parts
            .map(
                (part) =>
                    `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.eTag}</ETag></Part>`
            )
            .join('')}</CompleteMultipartUpload>`
        const signedRequest = this.signature.sign(
            {
                method: method,
                protocol: this.scheme,
                hostname: host,
                path: `/${objectKey}`,
                headers: {},
                body: body,
                query: {
                    uploadId: `${uploadId}`,
                },
            },
            {}
        )

        const res = await http.asyncRequest(method, signedRequest.url, signedRequest.body || '', {
            headers: signedRequest.headers,
        })

        this._handle_error('CompleteMultipartUpload', res)
    }

    /**
     * Aborts a multipart upload.
     *
     * @param  {string} bucketName - The bucket name containing the object.
     * @param  {string} objectKey - Key of the object to delete.
     * @param  {string} uploadId - The uploadId of the multipart upload to abort.
     * @throws  {S3ServiceError}
     * @throws  {InvalidSignatureError}
     */
    async abortMultipartUpload(bucketName: string, objectKey: string, uploadId: string) {
        // Prepare request
        const method = 'DELETE'
        const host = `${bucketName}.${this.host}`
        const signedRequest = this.signature.sign(
            {
                method: method,
                protocol: this.scheme,
                hostname: host,
                path: `/${objectKey}`,
                headers: {},
                query: {
                    uploadId: `${uploadId}`,
                },
            },
            {}
        )

        const res = await http.asyncRequest(method, signedRequest.url, signedRequest.body || '', {
            headers: signedRequest.headers,
        })
        this._handle_error('AbortMultipartUpload', res)
    }

    _handle_error(operation: S3Operation, response: RefinedResponse<ResponseType | undefined>) {
        const status: number = response.status
        const errorCode: number = response.error_code
        const errorMessage: string = response.error

        // We consider codes 200-299 as success
        if (status >= 200 && status < 300 && errorMessage == '' && errorCode === 0) {
            return
        }

        // A 301 response is returned when the bucket is not found.
        // Generally meaning that either the bucket name is wrong or the
        // region is wrong.
        //
        // See: https://github.com/grafana/k6/issues/2474
        // See: https://github.com/golang/go/issues/49281
        if (status == 301 || (errorMessage && errorMessage.startsWith('301'))) {
            throw new S3ServiceError('Resource not found', 'ResourceNotFound', operation)
        }

        const awsError = AWSError.parseXML(response.body as string)
        switch (awsError.code) {
            case 'AuthorizationHeaderMalformed':
                throw new InvalidSignatureError(awsError.message, awsError.code)
            default:
                throw new S3ServiceError(awsError.message, awsError.code || 'unknown', operation)
        }
    }
}

/** Class representing a S3 Bucket */
export class S3Bucket {
    name: string
    creationDate: Date

    /**
     * Create an S3 Bucket
     *
     * @param  {string} name - S3 bucket's name
     * @param  {Date} creationDate - S3 bucket's creation date
     */
    constructor(name: string, creationDate: Date) {
        this.name = name
        this.creationDate = creationDate
    }
}

/** Class representing an S3 Object */
export class S3Object {
    key: string
    lastModified: number
    etag: string
    size: number
    storageClass: StorageClass
    data?: string | bytes | null

    /**
     * Create an S3 Object
     *
     * @param  {string} key - S3 object's key
     * @param  {Date} lastModified - S3 object last modification date
     * @param  {string} etag - S3 object's etag
     * @param  {number} size - S3 object's size
     * @param  {StorageClass} storageClass - S3 object's storage class
     * @param  {string | bytes | null} data=null - S3 Object's data
     */
    constructor(
        key: string,
        lastModified: number,
        etag: string,
        size: number,
        storageClass: StorageClass,
        data?: string | bytes | null
    ) {
        this.key = key
        this.lastModified = lastModified
        this.etag = etag
        this.size = size
        this.storageClass = storageClass
        this.data = data
    }
}

/** Class representing a S3 Multipart Upload */
export class S3MultipartUpload {
    key: string
    uploadId: string

    /**
     * Create an S3 Multipart Upload
     * @param  {string} key - S3 object's key
     * @param  {string} uploadId - S3 multipart upload id
     */

    constructor(key: string, uploadId: string) {
        this.key = key
        this.uploadId = uploadId
    }
}

/** Class representing a S3 Part */
export class S3Part {
    partNumber: number
    eTag: string

    /**
     * Create an S3 Part
     * @param  {number} partNumber - Part number
     * @param  {string} eTag - Part's etag
     */

    constructor(partNumber: number, eTag: string) {
        this.partNumber = partNumber
        this.eTag = eTag
    }
}

/**
 * Error indicating a S3 operation failed
 *
 * Inspired from AWS official error types, as
 * described in:
 *   * https://aws.amazon.com/blogs/developer/service-error-handling-modular-aws-sdk-js/
 *   * https://github.com/aws/aws-sdk-js/blob/master/lib/error.d.ts
 */
export class S3ServiceError extends AWSError {
    operation: string

    /**
     * Constructs a S3ServiceError
     *
     * @param  {string} message - human readable error message
     * @param  {string} code - A unique short code representing the error that was emitted
     * @param  {string} operation - Name of the failed Operation
     */
    constructor(message: string, code: string, operation: string) {
        super(message, code)
        this.name = 'S3ServiceError'
        this.operation = operation
    }
}

/**
 * S3Operation describes possible values for S3 API operations,
 * as defined by AWS APIs.
 */
type S3Operation =
    | 'ListBuckets'
    | 'ListObjectsV2'
    | 'GetObject'
    | 'PutObject'
    | 'DeleteObject'
    | 'CopyObject'
    | 'CreateMultipartUpload'
    | 'CompleteMultipartUpload'
    | 'UploadPart'
    | 'AbortMultipartUpload'

/**
 * Describes the class of storage used to store a S3 object.
 */
type StorageClass =
    | 'STANDARD'
    | 'REDUCED_REDUNDANCY'
    | 'GLACIER'
    | 'STANDARD_IA'
    | 'INTELLIGENT_TIERING'
    | 'DEEP_ARCHIVE'
    | 'OUTPOSTS'
    | 'GLACIER_IR'
    | undefined
