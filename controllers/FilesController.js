import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { ObjectId } from 'mongodb';
import UserUtils from '../utils/user';
import dbClient from '../utils/db';
import redisClient from '../utils/redis';

const mime = require('mime-types');

class FilesController {
  static async postUpload(req, res) {
    try {
      const userid = await UserUtils.getUserIdFromToken(req);

      if (!userid) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const {
        name, type, parentId = 0, isPublic = false, data,
      } = req.body;

      if (!name) {
        return res.status(400).json({ error: 'Missing name' });
      }

      if (!type || !['folder', 'file', 'image'].includes(type)) {
        return res.status(400).json({ error: 'Missing type' });
      }

      if (type !== 'folder' && !data) {
        return res.status(400).json({ error: 'Missing data' });
      }
      if (parentId !== 0) {
        const parentFile = await dbClient.db.collection('files').findOne({ _id: ObjectId(parentId) });
        if (!parentFile) {
          return res.status(400).json({ error: 'Parent not found' });
        }
        if (parentFile.type !== 'folder') {
          return res.status(400).json({ error: 'Parent is not a folder' });
        }
      }

      const newFile = {
        userId: new ObjectId(userid),
        name,
        type,
        parentId: parentId === 0 ? 0 : new ObjectId(parentId),
        isPublic,
        localPath: '',
      };

      if (type === 'folder') {
        const result = await dbClient.db.collection('files').insertOne(newFile);
        return res.status(201).json({
          id: result.insertedId,
          userId: newFile.userId,
          name: newFile.name,
          type: newFile.type,
          isPublic: newFile.isPublic,
          parentId: newFile.parentId,
        });
      }

      const folderPath = process.env.FOLDER_PATH || '/tmp/files_manager';
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }

      const fileName = uuidv4();
      const filePath = path.join(folderPath, fileName);

      const fileData = Buffer.from(data, 'base64');
      fs.writeFileSync(filePath, fileData);

      newFile.localPath = filePath;
      const result = await dbClient.db.collection('files').insertOne(newFile);

      return res.status(201).json({
        id: result.insertedId,
        userId: newFile.userId,
        name: newFile.name,
        type: newFile.type,
        isPublic: newFile.isPublic,
        parentId: newFile.parentId,
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  static async getShow(req, res) {
    try {
      const token = req.headers['x-token'];
      if (!token) { return res.status(401).json({ error: 'Unauthorized' }); }
      const keyID = await redisClient.get(`auth_${token}`);
      if (!keyID) { return res.status(401).json({ error: 'Unauthorized' }); }
      const user = await dbClient.db.collection('users').findOne({ _id: ObjectId(keyID) });
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const fileId = req.params.id || '';
      const file = await dbClient.db.collection('files').findOne({ _id: ObjectId(fileId), userId: user._id });
      if (!file) {
        return res.status(404).json({ error: 'Not found' });
      }

      return res.status(200).json({
        id: file._id,
        userId: file.userId,
        name: file.name,
        type: file.type,
        isPublic: file.isPublic,
        parentId: file.parentId,
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  static async getIndex(req, res) {
    try {
      const user = await UserUtils.getUserIdFromToken(req);
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const userId = ObjectId(user);

      let parentId = req.query.parentId || '0';
      if (parentId !== '0') {
        parentId = ObjectId(parentId);
      }

      const pagination = parseInt(req.query.page, 10) || 0;

      const aggregationMatch = {
        $and: [
          { parentId },
          { userId },
        ],
      };

      let aggregateData = [
        { $match: aggregationMatch },
        { $skip: pagination * 20 },
        { $limit: 20 },
      ];

      if (parentId === '0') aggregateData = [{ $skip: pagination * 20 }, { $limit: 20 }];

      const files = await dbClient.db.collection('files').aggregate(aggregateData);
      const filesArray = [];
      await files.forEach((item) => {
        const fileItem = {
          id: item._id,
          userId: item.userId,
          name: item.name,
          type: item.type,
          isPublic: item.isPublic,
          parentId: item.parentId,
        };
        filesArray.push(fileItem);
      });

      return res.send(filesArray);
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  static async putPublish(req, res) {
    try {
      const user = await UserUtils.getUserIdFromToken(req);

      if (!user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const fileId = req.params.id || '';
      let file = await dbClient.db.collection('files').findOne({ _id: ObjectId(fileId), userId: ObjectId(user) });
      if (!file) {
        return res.status(404).json({ error: 'Not found' });
      }

      await dbClient.db.collection('files').updateOne(
        { _id: ObjectId(fileId) },
        { $set: { isPublic: true } },
      );

      file = await dbClient.db.collection('files').findOne({ _id: ObjectId(fileId), userId: ObjectId(user) });
      return res.status(200).json({
        id: file._id,
        userId: file.userId,
        name: file.name,
        type: file.type,
        isPublic: file.isPublic,
        parentId: file.parentId,
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  static async putUnpublish(req, res) {
    try {
      const user = await UserUtils.getUserIdFromToken(req);
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const fileId = req.params.id || '';
      let file = await dbClient.db.collection('files').findOne({ _id: ObjectId(fileId), userId: ObjectId(user) });
      if (!file) {
        return res.status(404).json({ error: 'Not found' });
      }

      await dbClient.db.collection('files').updateOne(
        { _id: ObjectId(fileId) },
        { $set: { isPublic: false } },
      );

      file = await dbClient.db.collection('files').findOne({ _id: ObjectId(fileId), userId: ObjectId(user) });

      return res.status(200).json({
        id: file._id,
        userId: file.userId,
        name: file.name,
        type: file.type,
        isPublic: file.isPublic,
        parentId: file.parentId,
      });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  static async getFile(req, res) {
    try {
      console.log('Request params:', req.params);
      const userId = await UserUtils.getUserIdFromToken(req);
      console.log(`userid: ${userId}`);

      const fileId = req.params.id || '';
      console.log(`file id: ${fileId}`);

      const file = await dbClient.db.collection('files').findOne({ _id: ObjectId(fileId) });
      if (!file) {
        return res.status(404).json({ error: 'Not found' });
      }

      if (!file.isPublic) {
        if (!userId) {
          return res.status(404).json({ error: 'Not found' });
        }
        if (userId !== file.userId.toString()) {
          return res.status(404).json({ error: 'Not found' });
        }
      }

      if (file.type === 'folder') {
        return res.status(400).json({ error: "A folder doesn't have content" });
      }

      if (!fs.existsSync(file.localPath)) {
        return res.status(404).json({ error: 'Not found' });
      }
      console.log(`localPath: ${file.localPath}`);

      const mimeType = mime.lookup(file.name) || 'application/octet-stream';
      const fileContent = fs.readFileSync(file.localPath);
      console.log(`file content: ${fileContent}`);

      res.setHeader('Content-Type', mimeType);
      return res.send(fileContent);
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }
}

export default FilesController;
