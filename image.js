'use strict';

var child = require('child_process');
var exec = child.exec;
var spawn = child.spawn;

// INTERNAL
var sof = {
	0xc0: true,
	0xc1: true,
	0xc2: true,
	0xc3: true,
	0xc5: true,
	0xc6: true,
	0xc7: true,
	0xc9: true,
	0xca: true,
	0xcb: true,
	0xcd: true,
	0xce: true,
	0xcf: true
};

function u16(buf, o) {
	return buf[o] << 8 | buf[o + 1];
}

function u32(buf, o) {
	return buf[o] << 24 | buf[o + 1] << 16 | buf[o + 2] << 8 | buf[o + 3];
}

exports.measureGIF = function(buffer) {
	return { width: buffer[6], height: buffer[8] };
};

// MIT
// Written by TJ Holowaychuk
// visionmedia
exports.measureJPG = function(buffer) {

	var len = buffer.length;
	var o = 0;

	var jpeg = 0xff == buffer[0] && 0xd8 == buffer[1];
	if (!jpeg)
		return;

	o += 2;

	while (o < len) {
		while (0xff != buffer[o]) o++;
		while (0xff == buffer[o]) o++;

		if (!sof[buffer[o]]) {
	        o += u16(buffer, ++o);
	        continue;
		}

		var w = u16(buffer, o + 6);
		var h = u16(buffer, o + 4);

		return { width: w, height: h };
	}

	return null;
};

// MIT
// Written by TJ Holowaychuk
// visionmedia
exports.measurePNG = function(buffer) {
	return { width: u32(buffer, 16), height: u32(buffer, 16 + 4) };
};

/*
	Image class
	@filename {String}
	@useImageMagick {Boolean} :: default false
*/
function Image(filename, useImageMagick) {

	var type = typeof(filename);

	this.builder = [];
	this.filename = type === 'string' ? filename : null;
	this.stream = type === 'object' ? filename : null;
	this.isIM = useImageMagick || false;

	if (!filename)
		throw new Error('Image filename is undefined.');
}

/*
	Clear all filter
	return {Image}
*/
Image.prototype.clear = function() {
	var self = this;
	self.builder = [];
	return self;
};

Image.prototype.measure = function(callback) {

	var self = this;
	var index = self.filename.lastIndexOf('.');

	if (!self.filename) {
		callback(new Error('Measure does not support stream.'));
		return;
	}

	if (index === -1) {
		callback(new Error('This type of file is not supported.'));
		return;
	}

	var extension = self.filename.substring(index).toLowerCase();
	var stream = require('fs').createReadStream(self.filename, { start:0, end: extension === '.jpg' ? 1000 : 24 });

	stream.on('data', function (buffer) {
		switch (extension) {
			case '.jpg':
				callback(null, exports.measureJPG(buffer));
				return;
			case '.gif':
				callback(null, exports.measureGIF(buffer));
				return;
			case '.png':
				callback(null, exports.measurePNG(buffer));
				return;
		}
		callback(new Error('This type of file is not supported.'));
	});

	stream.on('error', callback);
	return self;
};

/*
	Execute all filters and save image
	@filename {String}
	@callback {Function} :: optional
	return {Image}
*/
Image.prototype.save = function(filename, callback) {

	var self = this;

	if (typeof(filename) === 'function') {
		callback = filename;
		filename = null;
	}

	filename = filename || self.filename || '';

	var command = self.cmd(self.filename === null ? '-' : self.filename, filename);

	if (self.builder.length === 0) {
		if (callback)
			callback(null, filename);
		return;
	}

	var cmd = exec(command, function(error, stdout, stderr) {
		self.clear();
		if (callback) {
			if (error)
				callback(error, '');
			else
				callback(null, filename);
		}
	});

	if (self.stream)
		self.stream.pipe(cmd.stdin);

	return self;
};

Image.prototype.pipe = function(stream) {

	var self = this;

	if (self.builder.length === 0)
		return;

	var cmd = spawn(self.isIM ? 'convert' : 'gm', self.arg(self.filename === null ? '-' : self.filename, '-'));

	cmd.stderr.on('data', stream.emit.bind(stream, 'error'));
	cmd.stdout.on('data', stream.emit.bind(stream, 'data'));
	cmd.stdout.on('end', stream.emit.bind(stream, 'end'));
	cmd.on('error', stream.emit.bind(stream, 'error'));
	cmd.stdout.pipe(stream);

	if (self.stream)
		self.stream.pipe(cmd.stdin);

	return self;

};

/*
	Internal function
	@filenameFrom {String}
	@filenameTo {String}
	return {String}
*/
Image.prototype.cmd = function(filenameFrom, filenameTo) {

	var self = this;
	var cmd = '';

	self.builder.sort(function(a, b) {
		if (a.priority > b.priority)
			return 1;
		else
			return -1;
	});

	self.builder.forEach(function(o) {
		cmd += (cmd.length > 0 ? ' ' : '') + o.cmd;
	});

	return (self.isIM ? 'convert' : 'gm -convert') + ' "' + filenameFrom + '"' + ' ' + cmd + ' "' + filenameTo + '"';
};

/*
	Internal function
	@filenameFrom {String}
	@filenameTo {String}
	return {String}
*/
Image.prototype.arg = function(first, last) {

	var self = this;
	var arr = [];

	if (!self.isIM)
		arr.push('-convert');

	if (first)
		arr.push(first);

	self.builder.sort(function(a, b) {
		if (a.priority > b.priority)
			return 1;
		else
			return -1;
	});

	self.builder.forEach(function(o) {
		var index = o.cmd.indexOf(' ');
		if (index === -1)
			arr.push(o.cmd);
		else {
			arr.push(o.cmd.substring(0, index));
			arr.push(o.cmd.substring(index + 1).replace(/\"/g, ''));
		}
	});

	if (last)
		arr.push(last);

	return arr;
};

/*
	Identify image
	cb {Function} :: function(err, info) {} :: info.type {String} == 'JPEG' | 'PNG', info.width {Number}, info.height {Number}
	return {Image}
*/
Image.prototype.identify = function(cb) {
	var self = this;

	exec((self.isIM ? 'identify' : 'gm identify') + ' "' + self.fileName + '"', function(error, stdout, stderr) {

		if (error) {
			cb(error, null);
			return;
		}

		var arr = stdout.split(' ');
		var size = arr[2].split('x');
		var obj = {
			type: arr[1],
			width: utils.parseInt(size[0]),
			height: utils.parseInt(size[1])
		};

		cb(null, obj);
	});

	return self;
};

/*
	Append filter to filter list
	@key {String}
	@value {String}
	@priority {Number}
	return {Image}
*/
Image.prototype.push = function(key, value, priority) {
	var self = this;
	self.builder.push({ cmd: key + (value ? ' "' + value + '"' : ''), priority: priority });
	return self;
};

/*
	@w {Number}
	@h {Number}
	@options {String}
	http://www.graphicsmagick.org/GraphicsMagick.html#details-resize
*/
Image.prototype.resize = function(w, h, options) {
	options = options || '';

	var self = this;
	var size = '';

	if (w && h)
		size = w + 'x' + h;
    else if (w && !h)
		size = w;
    else if (!w && h)
		size = 'x' + h;

	return self.push('-resize', size + options, 1);
};

/*
	@w {Number}
	@h {Number}
*/
Image.prototype.resizeCenter = function(w, h) {
	return this.resize(w, h, '^').align('center').crop(w, h);
};

/*
	@w {Number}
	@h {Number}
	@options {String}
	http://www.graphicsmagick.org/GraphicsMagick.html#details-scale
*/
Image.prototype.scale = function(w, h, options) {
	options = options || '';

	var self = this;
	var size = '';

	if (w && h)
		size = w + 'x' + h;
    else if (w && !h)
		size = w;
    else if (!w && h)
		size = 'x' + h;

	return self.push('-scale', size + options, 1);
};

/*
	@w {Number}
	@h {Number}
	@x {Number}
	@y {Number}
	http://www.graphicsmagick.org/GraphicsMagick.html#details-crop
*/
Image.prototype.crop = function(w, h, x, y) {
	return this.push('-crop', w + 'x' + h + '+' + (x || 0) + '+' + (y || 0), 4);
};

/*
	@percentage {Number}
	http://www.graphicsmagick.org/GraphicsMagick.html#details-quality
*/
Image.prototype.quality = function(percentage) {
    return this.push('-quality', percentage || 80, 5);
};

/*
	@type {String}
*/
Image.prototype.align = function(type) {

	var output = '';

	switch (type.toLowerCase().replace('-', '')) {
		case 'left top':
		case 'top left':
			output = 'NorthWest';
			break;
		case 'left bottom':
		case 'bottom left':
			output = 'SouthWest';
			break;
		case 'right top':
		case 'top right':
			output = 'NorthEast';
			break;
		case 'right bottom':
		case 'bottom right':
			output = 'SouthEast';
			break;
		case 'left center':
		case 'center left':
		case 'left':
			output = 'West';
			break;
		case 'right center':
		case 'center right':
		case 'right':
			output = 'East';
			break;
		case 'bottom center':
		case 'center bottom':
		case 'bottom':
			output = 'South';
			break;
		case 'top center':
		case 'center top':
		case 'top':
			output = 'North';
			break;
		case 'center center':
		case 'center':
			output = 'Center';
			break;
		default:
			output = type;
			break;
	}

	return this.push('-gravity', output, 3);
};

/*
	@type {String}
*/
Image.prototype.gravity = function(type) {
	return this.align(type);
};

/*
	@radius {Number}
	http://www.graphicsmagick.org/GraphicsMagick.html#details-blur
*/
Image.prototype.blur = function(radius) {
    return this.push('-blur', radius, 10);
};

Image.prototype.normalize = function() {
	return this.push('-normalize', null, 10);
};

/*
	@deg {Number}
	http://www.graphicsmagick.org/GraphicsMagick.html#details-rotate
*/
Image.prototype.rotate = function(deg) {
	return this.push('-rotate', deg || 0, 8);
};

// http://www.graphicsmagick.org/GraphicsMagick.html#details-flip
Image.prototype.flip = function() {
	return this.push('-flip', null, 10);
};

// http://www.graphicsmagick.org/GraphicsMagick.html#details-flop
Image.prototype.flop = function() {
	return this.push('-flop', null, 10);
};

Image.prototype.minify = function() {
	return this.push('+profile',  '*');
};

Image.prototype.grayscale = function() {
	return this.push('-modulate 100,0', null, 10);
};

/*
	@color {String}
*/
Image.prototype.background = function(color) {
	return this.push('-background', color, 2);
};

Image.prototype.sepia = function() {
	return this.push('-modulate 115,0,100 \\ -colorize 7,21,50', null, 10);
};

/*
	@cmd {String}
	@priority {Number}
*/
Image.prototype.command = function(key, value, priority) {
	return this.push(cmd, null, priority || 10);
};

exports.Image = Image;
exports.Picture = Image;

/*
	Init image class
	@filename {String}
	@imageMagick {Boolean} :: default false
*/
exports.init = function(filename, imageMagick) {
	return new Image(filename, imageMagick);
};

exports.load = function(filename, imageMagick) {
	return new Image(filename, imageMagick);
};