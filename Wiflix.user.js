// ==UserScript==
// @name         Wiflix
// @version      1.11
// @description  Wiflix
// @include      https://*wiflix*/*
// @include      https://french-anime.com/*
// @include      https://*flemmix*/*
// @run-at       document-end
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM_addStyle
// ==/UserScript==

(async function() {
    var gridSuivi,gridSerie,gridOption,gridSuiviVu
    var container,containerSuivi,containerSerie,containerOption
    var myList
    var boutonSuivi,boutonSuppr,boutonVue

    await loadList()
    ModifStyle()

    var recherche = document.getElementsByClassName("search-page").length > 0
    CreationMiseEnPage()

    //Vue liste série
    if ((document.URL.split("/")[4] == "") || (document.URL.split("/")[3].split("?")[0] == "index.php")) {
        console.log("Accueil()")
        await Scan(Object.entries(document.querySelectorAll(".mov.clearfix")))
        Affichage()
        //Pas de page supplémentaire si recherche
        if (!recherche){
            await ChargementPageSup(2,20,document.URL.split("/")[3])
        }
    }

    //Vue série
    if (((document.URL.split("/")[3] == "serie-en-streaming") || (document.URL.split("/")[3] == "vf")) && (document.URL.split("/")[4] != "")) {
        console.log("Série()")
        await Serie()
    }

    //Vue anime
    if (((document.URL.split("/")[3] == "animes-vostfr") || (document.URL.split("/")[3] == "exclu")) && (document.URL.split("/")[4] != "")) {
        console.log("Anime()")
        await Anime()
    }

    //Vue Film
    if (document.URL.split("/")[3] == "film-en-streaming" && document.URL.split("/")[4] != "") {
        console.log("Film()")

    }

    //Création bouton
    function OptionCreate(option) {
        //console.log("boutonFollowCreate() : Creation du bouton Follow")
        var btn = document.createElement("button");
        btn.className = "boutonOption";
        btn.textContent = option

        var newBtn = btn.cloneNode(true)
        newBtn.addEventListener("click", (evt) => optionAction(option));
        gridOption.appendChild(newBtn);

    }

    //Action
    async function optionAction(option) {
        console.log(option)
    }

    //////////////////////// FONCTION ////////////////////////
    async function Anime(){}
    async function Serie(){
        var titre = document.getElementsByClassName("full-title")[0].innerText.split(" - Saison ")[0].trim()
        try{
            var saison = document.getElementsByClassName("full-title")[0].innerText.split(" - Saison ")[1].trim()
            }
        catch (err){
            saison = 1
        }
        console.log("Serie() : Titre : "+titre+" Saison : "+saison)
        boutonSuivi = document.createElement("btn")
        boutonSuivi.className = "bouton suivre"
        boutonSuivi.textContent = "Suivre"

        boutonSuppr = document.createElement("btn")
        boutonSuppr.className = "bouton suppr"
        boutonSuppr.textContent = "Supprimer"

        boutonVue = document.createElement("btn")
        boutonVue.className = "bouton vue"
        boutonVue.textContent = "Vue"


        var newBoutonSuivi
        var newBoutonSuppr
        var newBoutonVue
        Object.entries(document.getElementsByClassName("hostsblock")[0].getElementsByTagName("div")).forEach((entry) => {

            newBoutonSuivi = boutonSuivi.cloneNode(true)
            newBoutonSuivi.addEventListener("click", (evt) => boutonAction(titre,saison,"suivre"));
            newBoutonSuppr = boutonSuppr.cloneNode(true)
            newBoutonSuppr.addEventListener("click", (evt) => boutonAction(titre,saison,"supprimer"))
            newBoutonVue = boutonVue.cloneNode(true)
            newBoutonVue.addEventListener("click", (evt) => boutonAction(titre,saison,"vue"))

            if (entry[1].children.length > 0) {
                entry[1].children[0].before(newBoutonSuivi)
                entry[1].children[0].before(newBoutonSuppr)
                entry[1].appendChild(newBoutonVue)
            }

        })

        await SerieUpdate(titre,saison)

    }

    async function boutonAction(titre,saison,action){
        console.log("BoutonAction() - "+action)
        await loadList()
        if (action == "suivre"){
            if (!myList.hasOwnProperty(titre)) {myList[titre] = {}}
            myList[titre].Suivi = !myList[titre].Suivi
            myList[titre].Vue = 0.0
            myList[titre].Max = 0.0
            myList[titre].Lien = document.URL.split("/")[4]

        }
        else if (action == "supprimer"){
            if (myList.hasOwnProperty(titre)) {
                delete myList[titre];
                console.log("BoutonAction() - "+titre+" supprimé de la base")
            }
        }
        else if (action == "vue"){
            if (!myList.hasOwnProperty(titre)) {myList[titre] = {}}
            myList[titre].Suivi = true
            myList[titre].Vue = concatSaisonEp(saison,document.getElementsByClassName("clicbtn active")[0].innerText.split("Episode ")[1])
            myList[titre].Lien = document.URL.split("/")[4]
        }
        else if (action == "add"){
            var cardData = titre
            //titre == card
            console.log(cardData)
            //Déplacement de la carte vers la liste suivi
            containerSuivi.appendChild(cardData)

            //Détection des données
            var nom = cardData.getElementsByClassName("cardNom")[0].innerText
            var image = cardData.getElementsByClassName("cardImageImg")[0].src.split("/")[3]
            var lien = cardData.getElementsByClassName("cardImage")[0].href.split("/")[3]+"/"+cardData.getElementsByClassName("cardImage")[0].href.split("/")[4]

            //Création de l'entrée
            if (!myList.hasOwnProperty("film")){myList.film = {}}
            if (!myList.film.hasOwnProperty(nom)){
                myList.film[nom] = {}
                myList.film[nom].Suivi = true
                myList.film[nom].Vu = false
                myList.film[nom].Image = image
                myList.film[nom].Lien = lien
            }
            console.log(myList.film[nom])
        }

        await saveList()
        if (action != "add"){
            await SerieUpdate(titre,saison)
        }
    }

    function rechercheAction(event){
        console.log(event)
        if((event.key == "Enter") || (event == "")){
            window.open("https://"+document.URL.split("/")[2]+"/index.php?do=search&subaction=search&search_start=0&full_search=1&result_from=1&story="+document.getElementById("story").value+"&titleonly=3&searchuser=&replyless=0&replylimit=0&searchdate=0&beforeafter=after&sortby=date&resorder=desc&showposts=0&catlist%5B%5D=0","_self");
        }
    }

    async function SerieUpdate(titre,saison){

        await loadList()
        console.log("SerieUpdate() - Début : ")
        console.log(myList[titre])
        //Bouton suivre
        Object.entries(document.getElementsByClassName("bouton suivre")).forEach((entry) => {
            if (myList.hasOwnProperty(titre)) {
                if (myList[titre].Suivi)
                {
                    entry[1].textContent = "Suivi"
                }
                else
                {
                    entry[1].textContent = "Suivre"
                }}
            else {entry[1].textContent = "Suivre"}
        })

        //Liste episode
        Object.entries(document.getElementsByClassName("blocfr")[0].getElementsByClassName("clicbtn")).forEach((entry) => {
            var ep
            ep = concatSaisonEp(saison,entry[1].innerText.split("Episode ")[1])
            if (myList.hasOwnProperty(titre)) {
                //Episode déjà vu
                if(ep <= myList[titre].Vue)
                {
                    console.log("SerieUpdate() - Episode vu : " + ep)
                    entry[1].classList.add("epVu")
                }

                //Dernier episode
                if(ep >= myList[titre].Vue)
                {
                    console.log("SerieUpdate() - Nouvelle episode : " + ep)
                    myList[titre].Max = ep
                }}
            else{entry[1].classList.remove("epVu")}
        })

        console.log("SerieUpdate() - Fin : ")
        console.log(myList[titre])
        await saveList()
    }

    async function Scan(list){

        //console.log(list)
        list.forEach((entry) => {
            var serie = entry[1].getElementsByClassName("nbloc3").length == 0
            var result
            var titre,saison,langue,ep,image,lien,lienDernier,quali
            var max=0,vue=0

            if(serie){
                console.log("Scan - série")
                //var regexSerie = /(?<titre>[^\t\n]+)[\n \t]+Saison (?<saison>\d+)[\n \t]+(?<langue>.+)[\n \t]+Episode (?<ep>\d+)/i
                //old var regexSerie = /(?<titre>.+)\nSaison (?<saison>\d+) (?<langue>.+)\nEpisode (?<ep>\d+)/i
                //console.log(entry[1].innerText)
                try{

                    //console.log(entry[1].innerText)
                    //result = regexSerie.exec(entry[1].innerText)
                    //console.log(result)
                    titre = entry[1].getElementsByClassName("mov-t nowrap")[0].innerText.split(" - ")[0]
                    //titre = result.groups.titre
                    var regexSaison = /(Partie|Saison) (?<saison>\d+)[\n \t]+(?<langue>.+)/i
                    result =regexSaison.exec(entry[1].getElementsByClassName("block-sai")[0].innerText)
                    saison = "Saison "+result.groups.saison+" - "+result.groups.langue
                    //saison = "Saison "+result.groups.saison+" - "+result.groups.langue
                    //var regexEp = /Episode .{0,}(?<ep>\d{2,})/i
                    var regexEp = /.{0,}(?<ep>\d{2,})/i
                    var resultEP = regexEp.exec(entry[1].getElementsByClassName("block-ep")[0].innerText)
                    ep = "Episode "+resultEP.groups.ep
                    //ep = "Episode "+result.groups.ep
                    image = entry[1].getElementsByTagName("img")[0].src
                    lien = entry[1].getElementsByTagName("a")[0].href
                    lienDernier = lien

                    if (myList.hasOwnProperty(titre)){
                        console.log(titre)
                        console.log(myList[titre])
                        vue = myList[titre].Vue
                        lienDernier = myList[titre].Lien
                        max = myList[titre].Max
                        var suivi = myList[titre].Suivi
                        //Mise à jour du Max si French
                        if (myList[titre].Suivi && (result.groups.langue == "French")) {
                            if (concatSaisonEp(result.groups.saison,resultEP.groups.ep) > myList[titre].Max){
                                myList[titre].Max = concatSaisonEp(result.groups.saison,resultEP.groups.ep)
                                max = myList[titre].Max
                            }
                        }
                        //Mise à jour saison si VOSTFR
                        if (myList[titre].Suivi && (result.groups.langue == "VOSTFR")) {
                            if (concatSaisonEp(result.groups.saison,0) > vue){
                                //myList[titre].Max = concatSaisonEp(result.groups.saison,0)
                                //max = myList[titre].Max
                            }
                        }
                    }

                    AddCard(titre,saison,ep,vue,max,image,lien,lienDernier,suivi,false)
                }
                catch (err) {
                    console.log(err)
                    containerSerie.appendChild(entry[1].cloneNode(true))
                }
            }
            else
            {
                //console.log("Scan - film")
                var regexFilm = /(EXCLU\n||)(?<titre>.+)\n(?<langue>\w+)( (?<quali>[\w ]+)||)\n.+/i
                try{
                    result = regexFilm.exec(entry[1].innerText)
                    //console.log(result)
                    titre = result.groups.titre
                    quali = result.groups.quali
                    langue = result.groups.langue
                    image = entry[1].getElementsByTagName("img")[0].src
                    lien = entry[1].getElementsByTagName("a")[0].href
                    if ((langue != "VOSTFR") && (quali == "HDLIGHT")) {
                        AddCard(titre,langue,quali,0,0,image,"",lien,false,true)
                    }
                }
                catch (err) {
                    containerSerie.appendChild(entry[1].cloneNode(true))
                }
            }

        })
        await saveList()
    }

    function Affichage(){
        container = document.getElementById("cols");
        container.innerHTML = ""
        //container.appendChild(containerOption)
        container.appendChild(containerSuivi)
        container.appendChild(containerSerie)
    }

    function CreationMiseEnPage(){
        console.log("CréationMiseEnPage()")

        //Container Option
        containerOption = document.createElement("div")
        containerOption.className = "containerOption"
        containerOption.textContent = "Option"

        gridOption = document.createElement("div")
        gridOption.className = "gridOption"
        containerOption.appendChild(gridOption)

        OptionCreate("VOSTFR")
        OptionCreate("TS")

        //Container Suivi
        containerSuivi = document.createElement("div")
        containerSuivi.className = "containerSuivi"
        containerSuivi.textContent = "Suivi"

        gridSuivi = document.createElement("div")
        gridSuivi.className = "gridSuivi"
        containerSuivi.appendChild(gridSuivi)

        gridSuiviVu = document.createElement("div")
        gridSuiviVu.className = "gridSuiviVu"
        containerSuivi.appendChild(gridSuiviVu)

        //Container Serie
        containerSerie = document.createElement("div")
        containerSerie.className = "containerSerie"
        containerSerie.textContent = "Liste"

        gridSerie = document.createElement("div")
        gridSerie.className = "gridSerie"
        containerSerie.appendChild(gridSerie)

        //Bouton
        //Bouton Serie
        var boutonSerie = document.createElement("a")
        boutonSerie.className = "bouton Serie"
        boutonSerie.textContent = "Série"
        boutonSerie.href = "/serie-en-streaming/"
        document.getElementsByClassName("logotype")[0].after(boutonSerie)
        //Bouton Film
        var boutonFilm = document.createElement("a")
        boutonFilm.className = "bouton Film"
        boutonFilm.textContent = "Film"
        boutonFilm.href = "/film-en-streaming/"
        document.getElementsByClassName("logotype")[0].after(boutonFilm)
        //Bouton Anime
        var boutonAnime = document.createElement("a")
        boutonAnime.className = "bouton Anime"
        boutonAnime.textContent = "Anime"
        boutonAnime.href = "https://french-anime.com/animes-vostfr/"
        document.getElementsByClassName("logotype")[0].after(boutonAnime)
        //Gestion Search
        document.getElementById("story").addEventListener("keyup", (evt) => rechercheAction(event))

    }

    //Chargement de page supplémentaire
    async function ChargementPageSup(pageMin,pageMax,page) {
        var nbPage = 10
        var iframe
        //Création des iframe
        for (let i = pageMin; i <= pageMax; i++) {
            //console.log("Création de page : "+i)
            var x = i+2
            iframe = document.createElement("iframe")
            iframe.className = "pageSuppl"
            iframe.style = "display:block;width:0%"
            iframe.src = "https://"+document.URL.split('/')[2]+"/"+page+"/page/"+i.toString()
            document.body.appendChild(iframe)
            await attenteChargementPageSup()
            await Scan(Object.entries(document.getElementsByClassName("pageSuppl")[0].contentDocument.querySelectorAll(".mov.clearfix")))
            iframe.remove()
        }
    }

    //Attente du chargement d'une page supplémentaire
    async function attenteChargementPageSup() {
        if (document.querySelectorAll(".pageSuppl")[0].contentDocument.querySelectorAll(".mov.clearfix").length == 0){
            //console.log("Attente chargement page")
            await sleep(10)
            await attenteChargementPageSup();
        }
        else{
            //console.log("Element chargé")
        }
    }

    function AddCard(nom,ligne1,ligne2,vue,max,image,lien,lienDernier,suivi,film){

        //Carte
        var card = document.createElement("div")
        card.className = "card"

        //image
        var cardImage = document.createElement("a")
        cardImage.className = "cardImage"
        cardImage.href = lienDernier
        card.appendChild(cardImage)

        var cardImageTxt
        if (!film)
        {
            cardImageTxt = document.createElement("div")
            cardImageTxt.textContent = vue.toFixed(2)+" / "+max.toFixed(2)
            cardImageTxt.className = "cardImageTxt"
        }
        else
        {
            var cardBouton = document.createElement("btn")
            cardBouton.className = "cardBouton"
            cardBouton.textContent = "+"

            var newcardBouton = cardBouton.cloneNode(true)
            card.appendChild(newcardBouton)
            newcardBouton.addEventListener("click", (evt) => boutonAction(card,0,"add"))
        }

        var cardImageImg = document.createElement("img")
        cardImageImg.src = image
        cardImageImg.className = "cardImageImg"
        cardImage.appendChild(cardImageImg)

        //Nom
        var cardNom = document.createElement("div")
        cardNom.textContent = nom
        cardNom.className = "cardNom"
        card.appendChild(cardNom)

        //Saison
        var cardSaison
        if (lien == ""){
            cardSaison = document.createElement("div")
        }
        else
        {
            cardSaison = document.createElement("a")
            cardSaison.href = lien
        }

        cardSaison.textContent = ligne1
        cardSaison.className = "cardSaison"

        card.appendChild(cardSaison)

        //Episode
        var cardEpisode = document.createElement("div")
        cardEpisode.textContent = ligne2
        cardEpisode.className = "cardEpisode"
        card.appendChild(cardEpisode)

        if (suivi) {
            gridSuivi.appendChild(card)
            if((vue>=max) || (ligne1.split(" ")[1] < parseInt(vue))){
                card.classList.add("vu")
                gridSuiviVu.appendChild(card)
            }
            else{
                card.classList.add("suivi")
                cardImage.appendChild(cardImageTxt)
                if(ligne1.split(" - ")[1]=="VOSTFR"){
                    //card.classList.add("eng")
                }
            }
        }
        else{gridSerie.appendChild(card)}

    }

    function ModifStyle(){
        GM_addStyle(`
/* Style base */
.wrap{background:#212121;min-height:2000px}
.center{max-width:95%;}
.main {background-color: transparent;box-shadow: none;border-top:transparent;}
.cols {padding:0px 0 20px 0px;}
.header {position: relative;height: 100px;padding:20px 360px 20px 30%;background-color: transparent !important;}
.hostsframe {background-color: #fff0;}
body{color: #fff;}
.cols-mov{background-color: #fff0;box-shadow: #fff0;}
.tabsbox {margin-bottom: 20px;position: relative;width: 50%;left: 25%;}
.comm-two {background-color: #111;}
.show-login {display:none !important;}

/* Element perso */
.containerSuivi{color:#fff;float:left;width: 34%;min-height: 800px;padding: 20px 0px 0px 0px;font-weight: bold;font-size: 24px;text-align: center;}
.containerSerie{color:#fff;float:right;width: 66%;min-height: 800px;padding: 20px 0px 0px 0px;font-weight: bold;font-size: 24px;text-align: center;}
.containerOption{color: #fff;font-weight: bold;font-size: 14px;text-align: center;}
.gridSerie{padding: 10px;}
.gridSuivi{padding: 10px;}
.gridOption{padding: 10px;}

.card{position: relative;width:144px;background:#212121;float: left;margin:8px 8px 8px 8px;border:2px solid #ccc;height: 344px;text-align: center;font-size: 13px;font-weight: 600;border-radius:25px;overflow:hidden;}
.cardImage{height: 229px;display: block;}
.cardImageTxt {top: 5px;right: 5px;background:#d90000;color: #fff;padding:0 8px;line-height: 20px;height: 20px;font-size: 11px;position: absolute;border-radius:25px;}
.cardImageImg{width: 100%;height: 100%;}
.cardNom{margin:15px 10px 7px 10px;display: block;color: #fffdfd;white-space:nowrap;overflow:hidden;text-overflow: ellipsis;}
.cardSaison{color: #fffdfd;margin:15px 10px 7px 10px;display: block;  white-space:nowrap;}
.cardEpisode{color: #fffdfd;margin:15px 10px 7px 10px;}
.cardBouton{top: 7px;right: 7px;background:#d90000;color: #fff;font-size: 24px;position: absolute;border-radius:10px;text-align: center;width: 32px;height: 24px;line-height: 20px;z-index: 1;cursor: pointer;user-select: none;}

.suivi{background-color: seagreen !important;}
.vu{background-color: brown !important;}
.eng{background-color: darkblue !important;}
.epVu{text-decoration-line: line-through;color: #717171 !important;}

.bouton{cursor: pointer;width: 120px;line-height: 35px;text-align: center;border-radius:10px;background-color: #d90000;color: #fff;}
.bouton.Serie{position: absolute;left: 300px;top: 10px;font-size: 24px;}
.bouton.Film{position: absolute;left: 300px;bottom: 10px;font-size: 24px;}
.bouton.Anime{position: absolute;left: 430px;top: 10px;font-size: 24px;}
.bouton.vue{width:98.35px;height:50px;display: inline-block;cursor: pointer;margin-right: 15px;padding:0 20px;line-height: 50px;border-radius:25px;box-shadow: 2px 2px 2px 0 rgba(0, 0, 0, .1);background-color: #d90000;color: #fff;}
.bouton.suivre{width:98.35px;height:50px;display: inline-block;cursor: pointer;margin-right: 15px;padding:0 20px;line-height: 50px;border-radius:25px;box-shadow: 2px 2px 2px 0 rgba(0, 0, 0, .1);background-color: #d90000;color: #fff;}
.bouton.suppr{width:98.35px;height:50px;display: inline-block;cursor: pointer;margin-right: 15px;padding:0 20px;line-height: 50px;border-radius:25px;box-shadow: 2px 2px 2px 0 rgba(0, 0, 0, .1);background-color: #d90000;color: #fff;}


/* Element a cacher */
.newcarusel{display: none;}
.sidebar{display: none;}
.newmenu{display: none;}
.site-desc{display: none;}
.footer{display: none;}
.full-taglist{display: none;}
.std-block-title2{display: none;}
center{display:none;}
.search-inner button{display:none;}
.tcarusel.carou-top {display:none;}
.screenshots-full {display:none;}
.sadst {display:none;}
        `)
    }

    //Sauvegarde de la liste
    async function saveList(){
        console.log("Sauvegarde liste")
        var save = JSON.stringify(myList);
        //console.log(save)
        await GM.setValue('myList', save);
        console.log('Liste sauvegardé')
    }

    //Chargement de la liste
    async function loadList(){
        try{
            console.log("Chargement de la liste")
            var item = await GM.getValue('myList');
            myList = JSON.parse(item);
            console.log("Liste chargé")
            //console.log(myList)
        }
        catch (err)
        {
            onErrorList(err)
        }
    }

    //Si Erreur au chargement de la liste
    function onErrorList(error) {
        console.log(`Error: ${error}`);
        myList = {}
    }

    function concatSaisonEp(saison,ep){
        var result
        saison = parseFloat(saison)
        ep = parseFloat(ep)
        if (ep <10){result=String(saison)+".0"+String(ep)}else{result=String(saison)+"."+String(ep)}
        return parseFloat(result)
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
})();