#!/usr/bin/env node

var request     = require('request'),
    async       = require('async'),
    RSS         = require('rss'),
    cheerio     = require('cheerio'),
    fs          = require('fs'),
    mkdirp      = require('mkdirp'),
    path        = require('path'),
    ncp         = require('ncp'),
    optimist    = require('optimist'),
    ProgressBar = require('progress');

var cookieJar = request.jar();

var argv = optimist
          .usage('Convert the current NWZ ePaper issue to RSS.\nUsage: $0 -u [username] -p [password] -o [folder] -b [url]')
          .demand(['u', 'p', 'o'])
          .alias('u', 'username')
          .describe('u', 'NWZ ePaper Username')
          .default('u', process.env.NWZ_USERNAME)
          .alias('p', 'password')
          .describe('p', 'NWZ ePaper Password')
          .default('p', process.env.NWZ_PASSWORD)
          .alias('o', 'output')
          .describe('o', 'Output Folder where the generated Feed will land.')
          .default('o', "out/")
          .alias('b', 'base')
          .describe('b', 'Base URL for generated Feed')
          .default('b', 'http://localhost:8000')
          .alias('a', 'archive')
          .describe('a', 'Whether the issues should be archived or only the current issue should get saved.')
          .default('a', true)
          .argv;

var username = argv.u;
var password = argv.p;
var outputFolder = argv.o;
var url = argv.b;
var archive = argv.a;

var deleteFolderRecursive = function(path) {
  if( fs.existsSync(path) ) {
    fs.readdirSync(path).forEach(function(file,index){
      var curPath = path + "/" + file;
      if(fs.lstatSync(curPath).isDirectory()) { // recurse
        deleteFolderRecursive(curPath);
      } else { // delete file
        fs.unlinkSync(curPath);
      }
    });
    fs.rmdirSync(path);
  }
};

var AUTH_URL = "https://login.nwzonline.de/json/authenticate.php?callback=jQuery111105526024862398045_1473920759710&action=authenticate";
var INDEX_URL = "http://www.nwzonline.de/epaper-kiosk/3.2.0/kiosk";



var authenticate = function(username, password, cb) {
  console.log("Authenticating");
  request({url: AUTH_URL + "&userLogin=" + username + "&userPass=" + password, jar: cookieJar}, cb)
}

var getSections = function(id, sysDate, cb) {
  var url = "http://www.nwzonline.de/NWZ/ePaperIssue/epaper/NWZOnline/" + id + "/NWZ/Olde%20N/editions/P/edition.json?t=" + sysDate;

  request({url: url, jar: cookieJar}, function(error, response, body) {
    if(error) return cb(error);
    var sections = [];

    body = JSON.parse(body);

    for(var page in body.sections) {
      sections[page] = body.sections[page].screens[0].pages[0].sectionName
    }
    cb(null, sections);
  })
}

var getEditions = function(cb) {
  console.log("Parsing Editions");
  var editionsRegex = /var editions = (.*);/

  request({url: INDEX_URL, jar: cookieJar}, function(error, response, body) {
    if(error) return cb(error);
    cb(null, JSON.parse(body.match(editionsRegex)[0].replace("var editions = ", "").replace(";", "")).data.container);
  });
}

var getContent = function(id, sysDate, cb) {
  var url = "http://www.nwzonline.de/NWZ/ePaperIssue/epaper/NWZOnline/" + id + "/NWZ/Olde%20N/editions/P/contents.json?t=" + sysDate;

  request({url: url, jar: cookieJar}, function(error, response, body) {
    if(error) return cb(error);
    cb(null, JSON.parse(body));
  });
}

var getArticle = function(id, sysDate, page, storyId, cb) {
  var url = "http://www.nwzonline.de/NWZ/ePaperIssue/epaper/NWZOnline/" + id + "/NWZ/Olde%20N/" + page + "/contents/" + storyId + "/S.xml?t=" + sysDate;
  request({url: url, jar: cookieJar}, function(error, response, body) {
    if(error) return cb(error);
    cb(null, body);
  });
}

var downloadPicture = function(id, sysDate, page, storyId, pictureId, filename, cb) {
  var url = "http://www.nwzonline.de/NWZ/ePaperIssue/epaper/NWZOnline/" + id + "/NWZ/Olde%20N/" + page + "/contents/" + storyId + "/contents/" + pictureId + "/H.jpg?t=" + sysDate;
  request({url: url, jar: cookieJar}).pipe(fs.createWriteStream(filename).on('close', cb));
}

var writeArticle = function(id, article, cb) {
  fs.writeFileSync(getOutputFolderPath(id) + "/" + article.storyId + ".html", "<html><head><meta charset='utf-8'><title>" + article.title + "</title></head><body>" + article.body + "</body></html>");
}

var getArticlePage = function(number) {
  if(number == 1) return 1;
  return Math.floor((number) / 2) + 1;
}

var getOutputFolderPath = function(id) {
  return outputFolder + id;
}

var transformArticleBody = function(id, sysDate, page, storyId, body, cb) {
  if(body == undefined) return "";
  var $ = cheerio.load(body, {
    recognizeSelfClosing: true
  });

  $(".seitenverweis-ipad").remove()
  $(".pfeil-ipad").remove();
  $(".klammeraffe-ipad").remove()
  $(".headline").remove()
  $(".overhead").remove()
  $(".BildergalerieMax").remove()

  $(".frage-ipad").prepend("<div class='name-ipad'>FRAGE</div>" )
  $(".name-ipad").each(function() {
    $(this).text($(this).text() + ": ")
  });

  $(".autorenkuerzel-ipad").text($(".autorenkuerzel-ipad").text() + " - ")
  $("stichwort").text($("stichwort").text() + " ")
  $(".ortsmarke-ipad").text($(".ortsmarke-ipad").text() + " ")
  $(".autor-ipad").text("VON " + $(".autor-ipad").text())

  var image = $('aside[data-type="I"]');
  var imageId = image.attr('id');
  if(imageId) {
    var storyId = imageId.split("@")[1];
    imageId = imageId.split("@")[0];

    var imageFilename = getOutputFolderPath(id) + "/images/" + imageId + ".jpg";
    downloadPicture(id, sysDate, page, storyId, imageId, imageFilename, function() {
      image.prepend(function(index) {
        if(index == 0) return "<img class='image' src='" + url + "/" + id + "/images/" + imageId + ".jpg" + "' />";
        return "";
      });

      cb($.html(), $.text());
    });
  } else {
    return cb($.html(), $.text());
  }
}

var parseArticles = function(desiredId, desiredSysDate, content, sections, callback) {
  var articles = [];

  var bar = new ProgressBar('fetching articles [:bar] :percent :etas', { width: 20, total: Object.keys(content).length });
  async.eachLimit(Object.keys(content), 1, function(page, cb) {
    async.eachLimit(Object.keys(content[page]), 2, function(storyId, cb2) {
      var story = content[page][storyId];

      if (story.type == "S" && story.title != '') {
        return getArticle(desiredId, desiredSysDate, getArticlePage(parseInt(page)), storyId, function(error, body) {
          if(error) return cb2(error);

          transformArticleBody(desiredId, desiredSysDate, getArticlePage(parseInt(page)), storyId, body, function(articleBody, pureText) {
            var title = story.title.trim().replace(/\s\s+/g, ' ');
            if(title != '' && pureText.trim() != '') {
              articles[title] = {
                title: title,
                body: articleBody.trim(),
                storyId: storyId,
                formattedDate: story.formattedDate,
                section: sections[parseInt(page) - 1]
              };
            }
            cb2();
          });
        });
      }

      cb2();
    }, function(error) {
      bar.tick();
      cb(error);
    });

  }, function(error) {
    callback(error, articles);
  });
}

var generateEverything = function(id, articles, sections, cb) {
  var uniqueSections = [];
  for (var i in sections) {
    if (uniqueSections.indexOf(sections[i]) == -1) {
      uniqueSections.push(sections[i])
    }
  }

  var originalFirstTitle = uniqueSections[0];
  uniqueSections[0] = "Titelseite";

  var bar = new ProgressBar('generating feeds [:bar] :percent :etas', { width: 20, total: uniqueSections.length + 2, callback: cb });


  var finalSections = [];

  for(var i in uniqueSections) {
    section = uniqueSections[i];

    var sectionArticles = {};
    for (var title in articles) {
      var article = articles[title];
      if(article.section === section || (i == 0 && article.section == originalFirstTitle)) {
        sectionArticles[title] = article;
      }
    }

    if(Object.keys(sectionArticles).length == 0) {
      bar.tick();
      continue;
    }
    finalSections.push(section);

    var xml = generateFeed(id, i == 0 ? "NWZ" : "NWZ - " + section, url, sectionArticles)

    fs.writeFile(getOutputFolderPath(id) + "/feed-" + section + ".xml", xml, function(err) {
      if(err) {
        return console.error(err);
      }
      bar.tick();
    });
  }

  // ALL ARTICLE FEED
  var xml = generateFeed(id, "NWZ", url, articles)

  fs.writeFile(getOutputFolderPath(id) + "/feed.xml", xml, function(err) {
    if(err) {
      return console.error(err);
    }

    bar.tick();
  });

  fs.writeFile(getOutputFolderPath(id) + "/sections.json", JSON.stringify(finalSections), function(err) {
    if(err) {
      return console.error(err);
    }

    bar.tick();
  });
}

function generateFeed(id, title, feedUrl, articles) {
  var feed = new RSS({
    title: title,
    feed_url: feedUrl,
    site_url: "http://nwzonline.de"
  });

  for (var title in articles) {
    var article = articles[title];
    var articleUrl = archive ? url + "/" + id + "/" + article.storyId + ".html" : url + "/today/" + article.storyId + ".html"
    feed.item({
      title: title,
      url: articleUrl,
      guid: article.storyId,
      description: article.body,
      categories: [article.section]
    });
    writeArticle(id, article);
  }

  return feed.xml();
}

authenticate(username, password, function(error, response, body) {
  if(error) return console.error(error);
  getEditions(function(error, editions) {
    if(error) return console.error(error);
    var desiredId = editions[0].idContainer;
    var desiredSysDate = editions[0].product[0].edition[4].sysDate;
    deleteFolderRecursive(getOutputFolderPath(desiredId));
    mkdirp(getOutputFolderPath(desiredId) + '/images', function() {
      fs.writeFileSync(outputFolder + "/masthead.gif", fs.readFileSync(__dirname + "/masthead.gif"));
      console.log("Loading Sections");
      getSections(desiredId, desiredSysDate, function(error, sections) {
        if(error) return console.error(error);
        console.log("Loading Content");
        getContent(desiredId, desiredSysDate, function(error, content) {
          if(error) return console.error(error);
          console.log("Parsing Articles");
          parseArticles(desiredId, desiredSysDate, content, sections, function(err, articles) {
            if(err) return console.error(err);
            generateEverything(desiredId, articles, sections, function() {
              console.log("Copying newest issue to Today");
              deleteFolderRecursive(outputFolder + "today");
              ncp(getOutputFolderPath(desiredId), outputFolder + "/today/", function (err) {
                if (err) {
                  return console.error(err);
                }
                if(!archive) {
                  deleteFolderRecursive(getOutputFolderPath(desiredId));
                }
                console.log('Done!');
              });
            });
          });
        });
      });
    })
  });
});
